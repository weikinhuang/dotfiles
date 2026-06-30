# `memory.ts`

Claude Code–style multi-layered persistent memory. Where [`todo`](./todo.md) and [`scratchpad`](./scratchpad.md) are
per-session (state lives in the branch), `memory` is **cross-session** - state lives as markdown files on disk and
survives new sessions, `/compact`, and moving between workspaces.

## Layout

```text
${PI_MEMORY_ROOT:-~/.pi/agent/memory}/
├── global/
│   ├── MEMORY.md
│   ├── user/<slug>.md
│   └── feedback/<slug>.md
└── projects/<cwd-slug>/       ← same slug as ~/.pi/agent/sessions/<cwd-slug>/
    ├── MEMORY.md
    ├── user/<slug>.md
    ├── feedback/<slug>.md
    ├── project/<slug>.md
    ├── reference/<slug>.md
    └── sessions/<session-id>/  ← keyed on the session id, only loaded for that session
        ├── MEMORY.md
        └── note/<slug>.md
```

`<cwd-slug>` is pi's own convention: `/mnt/d/foo` → `--mnt-d-foo--`. So the memory dir for a given workspace sits right
next to its session log under the same slug. The `sessions/<session-id>/` subtree is keyed on pi's session id (the same
id as the `<session-id>.jsonl` transcript) and is only ever scanned for the session that owns it.

Each memory file has a strict five-key frontmatter (`name`, `description`, `type`, plus optional `created` / `updated`)
plus a markdown body. `created` / `updated` are full ISO-8601 UTC datetimes (e.g. `2026-06-30T14:22:01Z`) written
automatically by the tool: `save` stamps both, `update` preserves `created` and bumps `updated`. Files written before
timestamps existed (the original three-key form) still parse - their timestamps are simply absent, and a malformed
timestamp is tolerated as absent rather than rejecting the file. `MEMORY.md` is a one-line-per-memory index rebuilt by
the tool on every write - don't hand-edit it.

## Memory types

| Type        | Default scope | Purpose                                                                                 |
| ----------- | ------------- | --------------------------------------------------------------------------------------- |
| `user`      | `global`      | Role, expertise, preferences - who the user is and how they want to collaborate.        |
| `feedback`  | `global`      | Corrections and validated approaches. Save both don’t-do-X and keep-doing-Y.            |
| `project`   | `project`     | Decisions, incidents, deadlines for _this_ workspace. Decays fast - use absolute dates. |
| `reference` | `project`     | Pointers to external systems (Linear projects, dashboards, Slack channels).             |
| `note`      | `session`     | Freeform working notes for _this_ session only. Not loaded by any other session.        |

## Scopes

| Scope     | Keyed on   | Types                                      | Lifetime                                         |
| --------- | ---------- | ------------------------------------------ | ------------------------------------------------ |
| `global`  | -          | `user`, `feedback`                         | Shared across every pi session.                  |
| `project` | cwd slug   | `user`, `feedback`, `project`, `reference` | This workspace, across sessions.                 |
| `session` | session id | `note`                                     | This session only; other sessions never load it. |

Session memory requires an active session id. When pi runs without one (e.g. `--no-session`) session memory is disabled:
`save` with scope `session` returns an error and nothing is injected. Use scope `project` for notes that should outlive
the session.

## What the tool does

Registers a `memory` tool and a `/memory` command. Actions:

| Action   | Required                                    | Optional        | Purpose                                                                |
| -------- | ------------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| `list`   | -                                           | -               | Dump both indices (global + project).                                  |
| `read`   | `id`                                        | `type`, `scope` | Load a memory's full body.                                             |
| `save`   | `type`, `name`, `description`, `body`       | `scope`         | Write a new memory + update MEMORY.md.                                 |
| `update` | `id` + at least one of `name`/`desc`/`body` | `type`, `scope` | Rewrite fields; renames change the slug.                               |
| `remove` | `id`, `scope`                               | `type`          | Delete a memory + drop it from MEMORY.md.                              |
| `search` | `query`                                     | -               | Fuzzy + substring match over name/description/body, ranked best-first. |

For `save` with `scope: session`, `type` defaults to `note` (the only type valid in the session scope), so you can omit
it.

`search` ranks results by a lightweight multi-signal score: a fuzzy (subsequence) match on the name (weighted highest),
on the description (medium), and a substring match on the body (low). The body is only read for an entry when its
name+description score is weak, so a strong header hit avoids a disk read.

On `save`, the tool runs two non-blocking checks before writing:

- **Duplicate detection.** If the new memory looks similar (by name) to an existing memory of the same scope+type, the
  result is prefixed with a note suggesting `update` instead. The save still proceeds - false positives never block a
  legitimate write.
- **Secrets.** Memory does not run its own credential scan - secret-shaped content is gated upstream by the
  [`secret-redactor`](./secret-redactor.md) extension's tool-arg guard before it ever reaches the `memory` tool, so a
  credential never lands in a memory file on disk.

## Session-prompt integration

On `session_start` / `session_tree` the extension scans the global and project memory dirs - plus the current session's
dir when a session id is resolved - rebuilds an in-memory index, and mirrors that index snapshot (not bodies) to a
`memory-state` session entry so `/fork` and `/tree` show the correct view. On `before_agent_start` it appends a
`## Memory` block with the per-type index (Global / Project / Session) to the system prompt, capped by
`PI_MEMORY_MAX_INJECTED_CHARS` (default 3000). The model is expected to call `memory` action `read` when it needs a full
body.

**Stale annotation.** `project`-type entries older than `PI_MEMORY_STALE_DAYS` (default 30, measured from `updated`
falling back to `created`, truncated to whole days) get a tiny `(Nd)` age marker appended in the injected index - a soft
nudge to verify or refresh before relying on a fast-decaying project fact. Only `project` is annotated; `user` /
`feedback` / `reference` / `note` are never marked, and an undated entry is never marked. The marker is deliberately
tiny so it barely costs budget.

## Recall

The static `## Memory` index above tells the model _what_ exists; **recall** adds _what is relevant to this prompt_. On
every turn (via the `context` hook, not the system prompt) the extension scores the whole index - global + project +
session - against the latest user prompt with the same multi-signal scorer `search` uses, takes the top matches, and
surfaces them as an ephemeral `<system-reminder id="memory-recall">`. This closes the keyword-only gap: a prompt about
_port conflicts_ can still surface a memory whose description says _docker-compose mapping_, because the scorer is fuzzy
and substring-based, not exact-keyword.

Crucially this rides the **turn**, never the cached system prompt. The static index stays byte-stable so the provider's
prompt-prefix (KV) cache survives turn-to-turn; only the small recall reminder varies per prompt. The latest prompt is
captured in `before_agent_start` (which carries the raw prompt) and consumed in the `context` handler (which only sees
messages) - `before_agent_start` fires once per submit, before the agent loop emits the turn's first `context`, so the
value is fresh.

Two modes:

- **Marking (default, ≈free).** Emits a one-line reminder naming the most-relevant ids, e.g. _"Most relevant saved
  memories for this request: `auth-mock-policy`, `release-freeze` - use `memory read` to load them."_ The model still
  decides whether to `read` them, and verification-before-trust still applies.
- **Body injection (`PI_MEMORY_RECALL_BODIES=1`).** Injects the matched bodies (each capped at
  `PI_MEMORY_RECALL_BODY_BUDGET`) under a `## Relevant memory` heading so the model skips the `read` round-trip. Costs
  tokens every turn, so it is off by default. Marking and body injection are mutually exclusive - exactly one is
  emitted.

An empty prompt, no memories, or no matches injects nothing. Disable the whole feature with
`PI_MEMORY_DISABLE_RECALL=1`.

## Capture-assist

Compaction is the moment context - and any durable fact that surfaced mid-session but was never `memory save`d - is
summarized away. On `session_before_compact` the extension arms a one-shot flag; the next `context` hook splices a short
`<system-reminder>` into the turn nudging the model to persist anything worth keeping. This is purely a _timing_ prompt:
the model already carries the [`memory-first`](../skills/memory-first/SKILL.md) skill describing _what_ to save, so the
nudge just reminds it _when_. It does not analyze the transcript or propose candidates.

Pi's `session_before_compact` handler can only cancel or replace the compaction - it cannot inject conversation context

- so the reminder rides the following turn via the `context` hook (the same cache-safe seam as recall) to reach the
  model itself, rather than only the UI.

**Nag-fatigue gating.** A reminder on every compaction would be noise, so the nudge is suppressed unless there is
plausibly something unsaved to capture: there must have been at least one user turn since the last successful save this
session. Each user submit increments a counter; a successful `memory save` resets it to zero, so back-to-back
compactions with no intervening user activity stay quiet. The nudge is also suppressed entirely when memory can't be
written (`PI_MEMORY_READONLY=1` - no point nudging a save you can't make) or when it is turned off
(`PI_MEMORY_DISABLE_CAPTURE=1`).

This is "Depth A" (timing nudge only). Transcript analysis that proposes specific save candidates is a deliberately
deferred follow-up.

## Commands

- `/memory` (or `/memory list`) - raw state dump of all indices (global + project + session).
- `/memory preview` - shows the exact `## Memory` block that would be appended to the next turn's system prompt,
  honouring `PI_MEMORY_MAX_INJECTED_CHARS` and `PI_MEMORY_DISABLE_AUTOINJECT`.
- `/memory dir` - prints the memory root, global dir, project dir, session dir, and the cwd-slug + session id pi
  resolved.
- `/memory rescan` - re-read disk. Useful if another process edited a memory file underneath pi.
- `/memory stale` - list project-scope memories older than `PI_MEMORY_STALE_DAYS`, oldest first, with their age in days.
  Read-only; never auto-deletes - review and `update` or `remove` as needed.
- `/memory gc` - prune session memory dirs whose session id no longer has a transcript in pi's session dir. The current
  session is always kept. No-op (with a warning) when no session dir is resolvable.

## Environment variables

- `PI_MEMORY_DISABLED=1` - skip the extension entirely.
- `PI_MEMORY_DISABLE_AUTOINJECT=1` - keep the tool but don't append `## Memory` to the system prompt.
- `PI_MEMORY_MAX_INJECTED_CHARS=N` - soft cap on the injected block (default `3000`, floor `500`). The budget is
  consumed in priority order (session → project → global) so the scopes most relevant to the current turn survive a
  tight cap; the rendered block still displays global → project → session.
- `PI_MEMORY_STALE_DAYS=N` - age in days past which a `project` memory gets the `(Nd)` marker in the injected index and
  shows up in `/memory stale` (default `30`). Never auto-deletes; surfaces age and lets the model / user decide.
- `PI_MEMORY_ROOT=<path>` - override `~/.pi/agent/memory` (useful for testing / per-host profiles).
- `PI_MEMORY_READONLY=1` - block `save` / `update` / `remove` (they return a clear error); `list` / `read` / `search`
  and auto-injection still work. Useful in CI, shared/managed config, or "don't let this session mutate my memory" runs.
- `PI_MEMORY_DISABLE_RECALL=1` - turn off per-turn relevance recall (both marking and body injection). The static
  `## Memory` index is unaffected.
- `PI_MEMORY_RECALL_TOPK=N` - number of relevant memories to surface each turn (default `3`, floor `1`).
- `PI_MEMORY_RECALL_BODIES=1` - inject the matched bodies into the turn instead of marking their ids (default off, i.e.
  marking).
- `PI_MEMORY_RECALL_BODY_BUDGET=N` - per-body char cap when `PI_MEMORY_RECALL_BODIES=1` (default `1500`, floor `100`).
- `PI_MEMORY_DISABLE_CAPTURE=1` - turn off the capture-assist nudge spliced into the turn after a compaction (see
  [Capture-assist](#capture-assist)). The nudge is independently suppressed under `PI_MEMORY_READONLY=1`.

## Hot reload

Edit [`extensions/memory.ts`](./memory.ts) or the helpers under
[`lib/node/pi/memory-reducer.ts`](../../../lib/node/pi/memory-reducer.ts) /
[`lib/node/pi/memory-paths.ts`](../../../lib/node/pi/memory-paths.ts) /
[`lib/node/pi/memory-prompt.ts`](../../../lib/node/pi/memory-prompt.ts) /
[`lib/node/pi/memory-recall.ts`](../../../lib/node/pi/memory-recall.ts) /
[`lib/node/pi/memory-capture.ts`](../../../lib/node/pi/memory-capture.ts) and run `/reload`.

Companion skill: [`skills/memory-first/SKILL.md`](../skills/memory-first/SKILL.md) - when to save, when NOT to save, and
how to structure bodies for each type.
