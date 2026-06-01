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

Each memory file has a strict three-key frontmatter (`name`, `description`, `type`) plus a markdown body. `MEMORY.md` is
a one-line-per-memory index rebuilt by the tool on every write - don't hand-edit it.

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

| Action   | Required                                    | Optional        | Purpose                                            |
| -------- | ------------------------------------------- | --------------- | -------------------------------------------------- |
| `list`   | -                                           | -               | Dump both indices (global + project).              |
| `read`   | `id`                                        | `type`, `scope` | Load a memory's full body.                         |
| `save`   | `type`, `name`, `description`, `body`       | `scope`         | Write a new memory + update MEMORY.md.             |
| `update` | `id` + at least one of `name`/`desc`/`body` | `type`, `scope` | Rewrite fields; renames change the slug.           |
| `remove` | `id`, `scope`                               | `type`          | Delete a memory + drop it from MEMORY.md.          |
| `search` | `query`                                     | -               | Case-insensitive match over name/description/body. |

For `save` with `scope: session`, `type` defaults to `note` (the only type valid in the session scope), so you can omit
it.

## Session-prompt integration

On `session_start` / `session_tree` the extension scans the global and project memory dirs - plus the current session's
dir when a session id is resolved - rebuilds an in-memory index, and mirrors that index snapshot (not bodies) to a
`memory-state` session entry so `/fork` and `/tree` show the correct view. On `before_agent_start` it appends a
`## Memory` block with the per-type index (Global / Project / Session) to the system prompt, capped by
`PI_MEMORY_MAX_INJECTED_CHARS` (default 3000). The model is expected to call `memory` action `read` when it needs a full
body.

## Commands

- `/memory` (or `/memory list`) - raw state dump of all indices (global + project + session).
- `/memory preview` - shows the exact `## Memory` block that would be appended to the next turn's system prompt,
  honouring `PI_MEMORY_MAX_INJECTED_CHARS` and `PI_MEMORY_DISABLE_AUTOINJECT`.
- `/memory dir` - prints the memory root, global dir, project dir, session dir, and the cwd-slug + session id pi
  resolved.
- `/memory rescan` - re-read disk. Useful if another process edited a memory file underneath pi.
- `/memory gc` - prune session memory dirs whose session id no longer has a transcript in pi's session dir. The current
  session is always kept. No-op (with a warning) when no session dir is resolvable.

## Environment variables

- `PI_MEMORY_DISABLED=1` - skip the extension entirely.
- `PI_MEMORY_DISABLE_AUTOINJECT=1` - keep the tool but don't append `## Memory` to the system prompt.
- `PI_MEMORY_MAX_INJECTED_CHARS=N` - soft cap on the injected block (default `3000`, floor `500`).
- `PI_MEMORY_ROOT=<path>` - override `~/.pi/agent/memory` (useful for testing / per-host profiles).

## Hot reload

Edit [`extensions/memory.ts`](./memory.ts) or the helpers under
[`lib/node/pi/memory-reducer.ts`](../../../lib/node/pi/memory-reducer.ts) /
[`lib/node/pi/memory-paths.ts`](../../../lib/node/pi/memory-paths.ts) /
[`lib/node/pi/memory-prompt.ts`](../../../lib/node/pi/memory-prompt.ts) and run `/reload`.

Companion skill: [`skills/memory-first/SKILL.md`](../skills/memory-first/SKILL.md) - when to save, when NOT to save, and
how to structure bodies for each type.
