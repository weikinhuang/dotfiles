# `subagent.ts`

Claude Code `Task` / opencode / codex-style in-process sub-agent delegation. The parent LLM calls a single
`subagent(agent, task)` tool; the extension spins up a throwaway child `AgentSession` with its own context, tool
allowlist, and - optionally - a dedicated model or a git-worktree sandbox. The parent only sees the child's final
answer; intermediate tool churn stays in the child's own session file.

## Why

Small models hoarding the parent's context on broad exploration (“read 40 files and summarize”) is a common failure mode
that [`tool-output-condenser`](./tool-output-condenser.md) can only partially address. This extension shifts the entire
exploration subtree into a child session so the parent's context window stays clean. It composes with
[`scratchpad`](./scratchpad.md) and [`todo`](./todo.md): the parent keeps its plan + notebook while the child handles
the leg-work.

## What the tool does

Registers `subagent` and `subagent_send` with `executionMode: "parallel"`, plus `/agents`.

- **Single call, parallel fan-out.** The parent model invokes `subagent` once per delegation; to fan out, it calls the
  tool multiple times in one assistant turn. An in-process semaphore caps concurrency at
  [`PI_SUBAGENT_CONCURRENCY`](#environment-variables) (default 4, hard ceiling 8).
- **No nested delegation.** The default agent definitions do NOT include `subagent` in their tool lists - Claude Code,
  opencode, and codex all make the same choice. Prevents runaway fan-out.
- **Context isolation.** By default the child starts with no parent chat history - only the workspace's `AGENTS.md` /
  `CLAUDE.md` files and the agent definition's system-prompt body are injected. Opt into inheriting the parent's full
  history with [Fork mode](#fork-mode).
- **Guardrail inheritance.** `bash-permissions.json` / `filesystem.json` rule layers apply in the child because both
  extensions re-read them on every tool call. The **session allowlist** (in-memory approvals) does NOT cross the
  boundary - fresh child, fresh approvals.
- **Parent never sees intermediate tool output.** The child's own session file records every call; the parent's
  `tool_result` carries only the final answer text. A collapsible `subagent-run` message in the parent transcript
  renders the one-liner status with an expand-to-markdown view of the answer.

## Execution lifecycle

Foreground, background, and forked children share `createChildRun` in
[`spawn.ts`](../../../lib/node/pi/subagent/spawn.ts), also used by `runOneShotAgent`. It owns model-step counting,
timeouts, cancellation, result classification, event subscriptions, and disposal. Foreground/background differ in who
awaits completion, not in lifecycle behavior.

Queued calls and asynchronous setup honor cancellation before the first prompt. Background calls detach from their
spawning turn after launch, but remain attached to parent-session shutdown. `subagent_send` supports status, steering,
wait, and abort; cancelling a wait does not cancel the child. Shutdown awaits a bounded drain before clearing state;
late completions cannot update a replacement session's status, audit entries, or totals.

One model response plus its requested tools consumes one `maxTurns` step. Multiple tools in that response share the
step; processing their results in another model response consumes another. A final answer on the last allowed step is
successful completion. Pending continuation at the cap returns `max_turns`; no extra summary call is added.

### Early-stop results

A child that does not complete normally never returns its last mid-task message as the headline. The result (sync
`subagent`, `subagent_send wait`, and the `subagent_send status` of a finished child) leads with what stopped it, then
the files it tried to write (`write` / `edit` / `apply_patch` call paths, tracked from the child's tool events), then
the child's last assistant text as a trailing `Last message:` section:

```text
subagent "general-purpose" timed out after 300s (23 turns); partial changes may be on disk:
- config/pi/extensions/context-window.ts
- tests/lib/node/pi/context-window.spec.ts

Last message:
Now update the tests.
```

Other headlines: `hit its N-turn limit after Xs`, `was aborted after Xs`, `failed after Xs (N turns): <error>`. With no
recorded writes the line ends
`no write/edit/apply_patch calls were recorded (bash commands may still have changed files)`. `details.timedOut`,
`details.timeoutMs`, and `details.touchedFiles` carry the same data; the scorecard lead shows `timed out`. A running
child's `subagent_send status` lists `files written so far`. Formatting lives in
[`result.ts`](../../../lib/node/pi/subagent/result.ts) (`formatStopSummary` / `formatRunResultText`); path extraction in
[`touched-files.ts`](../../../lib/node/pi/subagent/touched-files.ts).

## Agent definitions

Markdown files with YAML frontmatter, discovered across three priority layers (higher wins by `name`):

| Layer    | Path                            | Scope            |
| -------- | ------------------------------- | ---------------- |
| 1 (low)  | `~/.dotfiles/config/pi/agents/` | Global defaults  |
| 2        | `~/.pi/agent/agents/`           | User overrides   |
| 3 (high) | `<cwd>/.pi/agents/`             | Project override |

Frontmatter schema:

| Field                | Type                       | Default                  | Meaning                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | string (required)          | -                        | LLM-visible agent identifier. Must match `[a-z][a-z0-9-]*`.                                                                                                                                                                                                           |
| `description`        | string (required)          | -                        | Explains WHEN to delegate. Surfaced to the parent LLM in the tool description.                                                                                                                                                                                        |
| `tools`              | string[]                   | `[read, grep, find, ls]` | Child tool allowlist. Unknown names warn at load; known parent-only extension tools cause a dispatch error instead of being silently omitted.                                                                                                                         |
| `model`              | `inherit` \| `provider/id` | `inherit`                | Which model answers. `inherit` reuses the parent's current model.                                                                                                                                                                                                     |
| `thinkingLevel`      | `off…xhigh`                | inherit                  | Clamped to the chosen model's capabilities.                                                                                                                                                                                                                           |
| `maxTurns`           | number                     | `20`                     | Hard cap on model steps, including tool continuations. Natural completion on the last allowed step succeeds.                                                                                                                                                          |
| `timeoutMs`          | number                     | `180000`                 | Wall-clock cap - aborts the child session. A per-call `timeoutMs` replaces it (see [Per-call overrides](#per-call-overrides)).                                                                                                                                        |
| `isolation`          | `shared-cwd` \| `worktree` | `shared-cwd`             | `worktree` creates an owned temporary linked checkout. Only clean owned checkouts are removed; child changes and commits remain recoverable.                                                                                                                          |
| `context`            | `fresh` \| `inherit`       | `fresh`                  | `inherit` forks the parent's full conversation history into the child (see [Fork mode](#fork-mode)). `fresh` starts blank with only the persona + task.                                                                                                               |
| `appendSystemPrompt` | string                     | -                        | Extra text appended to pi's default system prompt, before the Markdown body. Rare escape hatch.                                                                                                                                                                       |
| `bashAllow`          | string[]                   | `[]`                     | Per-agent bash allowlist enforced inside the child session via the inline `agent-gate` extension factory. Same matcher semantics as persona's `bashAllow` (head-token exact / `prefix *` / `*`). Empty means "no opinion".                                            |
| `bashDeny`           | string[]                   | `[]`                     | Per-agent bash denylist. `bashAllow` wins over `bashDeny` on overlap, mirroring the persona side. Empty means "no opinion".                                                                                                                                           |
| `writeRoots`         | string[]                   | `[]`                     | Positive `write` / `edit` allowlist enforced inside the child. Tilde and `{projectSlug}` substitution. Empty means writes are unconstrained inside the child (current default). Non-empty means writes outside the listed roots are blocked with a tool-result error. |
| `requestOptions`     | object                     | -                        | Free-form deep-merge into the child's outgoing provider payload via `before_provider_request`. Same shape and `apis: [...]` filter as persona's `requestOptions`. See [`./persona.md`](./persona.md) `requestOptions`.                                                |

### Per-agent gate enforcement

`bashAllow` / `bashDeny` / `writeRoots` / `requestOptions` are enforced by an inline `ExtensionFactory` installed inside
the child session, NOT by the parent's `bash-permissions` / `filesystem` / `persona` extensions. Pi's extension loader
supports `extensionFactories` on `DefaultResourceLoader` even when `noExtensions: true` is set, which is how the
subagent extension keeps the layered-on-disk extensions out of children while still gating per-agent.

- The factory closes over the agent's resolved configuration at spawn time, so each child enforces its own rules
  independently - parallel subagents do not share state. Agent denials run before parent approval and sandbox hooks;
  bash matching also recovers the original command if another hook already wrapped it. Parent gates remain binding.
- `writeRoots` resolves at spawn time relative to the child cwd (homedir + `{projectSlug}` substitution mirrors the
  persona resolver). Non-empty `writeRoots` is a binding allowlist; empty `writeRoots` is treated as "no opinion".
- The child runs with `hasUI: false`, so the gate never prompts - a `write` outside `writeRoots` is blocked with a
  diagnostic the model can act on. `bash` denials work the same way.
- The supplementary `lib/node/pi/subagent/active-agent.ts` cross-extension singleton publishes the running agent's
  snapshot so parent observers (statusline integrations etc.) can see what's running, but it is NOT used for enforcement
  - the inline factory's per-child closure is the authoritative gate.

Default agents shipped with the dotfiles:

- **`explore`** - read-only (`read, grep, find, ls`), `thinkingLevel: low`, `maxTurns: 12`. Use for "find X across the
  codebase" / "summarize what this module does".
- **`plan`** - same read-only toolkit, `thinkingLevel: medium`, `maxTurns: 16`. Turns a vague problem into a
  step-by-step implementation plan grounded in real files.
- **`general-purpose`** - full default tool set (`bash, read, write, edit, grep, find, ls`), `maxTurns: 50`,
  `timeoutMs: 600000` (10 min). Catch-all when the subtask needs both reads and edits.
- **`implementer`** - same tool set, `maxTurns: 150`, `timeoutMs: 2400000` (40 min). Long-running scoped implementation
  with tests; its prompt tells it to edit only the files the task assigns (parallel children share the checkout). See
  [`../agents/README.md`](../agents/README.md) for picking a cheaper `modelOverride` for mechanical work.

All of these deliberately exclude `memory`. Parent extension tool handlers are not automatically inherited: requesting
`memory` or another parent-only tool fails with an actionable error unless a child-safe factory registers it. Merely
adding its name to `tools` does not copy parent-session state into the child.

## Parent-UI approval bridge

Subagent children are created with `createAgentSession` and never get a UI context wired in, so `ctx.hasUI` is `false`
inside the child. Without help, the parent's injected security gates (`bash-permissions`, `filesystem`) can only block
or allow a gated child tool call - they can't show a dialog, because the child has no UI of its own.

This extension closes that gap by bridging the child's approval to the **parent's** interactive UI:

- On `session_start` (when the parent has a UI and the feature isn't disabled) it publishes `ctx.ui` via
  [`lib/node/pi/subagent/parent-prompt.ts`](../../../lib/node/pi/subagent/parent-prompt.ts) (`setParentPromptUI`), a
  `globalThis`-anchored singleton the gate extensions read.
- Around each child run it registers the child's identity (`agent`, `handle`, `source`) keyed by the child session id
  (`registerChildPromptIdentity`), and unregisters it once the child's prompt settles.
- When a gate fires inside a UI-less child, it calls `resolveParentPrompt(sessionId)`. If a parent UI is published and
  the session is a registered child, the gate prompts the parent's dialog - prefixed `subagent <agent> (<handle>)` - and
  applies the decision (`Allow once` / `Allow for this session` / `Deny` / `Deny with feedback…`).
- Concurrent children share one parent UI, so prompts are **serialized** through `runSerialPrompt` (a promise-chain
  mutex): parallel subagents queue and prompt one at a time rather than racing the dialog.

This is layered on top of the per-agent gate enforcement above - a `bashDeny` / out-of-`writeRoots` denial still blocks
with a tool-result error and never reaches the prompt. The bridge only changes what happens to an _unknown_ (would-have
prompted) command or protected path: instead of failing closed, it asks the user at the parent.

Disable with `PI_SUBAGENT_DISABLE_PARENT_PROMPT=1` (children then fall back to `PI_BASH_PERMISSIONS_DEFAULT` /
`PI_FILESYSTEM_DEFAULT`, default deny). The bridge is also inert in headless `pi -p` (no parent UI is published), so
non-interactive runs keep their existing fail-closed semantics. Children spawned by other paths (`deep-research` fanout,
the `iteration-loop` critic) are not registered here, so they keep the non-interactive fallback too.

## Session persistence

Each child invocation writes to its own on-disk session file, nested under the parent's **effective session dir**:

```text
<parent-session-dir>/<parent-session-id>/subagents/<iso-timestamp>\_<child-session-id>.jsonl
```

`<parent-session-dir>` is `sessionManager.getSessionDir()` - by default `~/.pi/agent/sessions/<parent-cwd-slug>/`, so
the on-disk path is identical to the historical layout. Because it is the _effective_ session dir, child transcripts
**follow `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` automatically**: the base moves, the `<parentSid>/subagents/`
layout beneath stays the same. Setting [`PI_SUBAGENT_SESSION_ROOT`](#environment-variables) instead points the base at
an explicit root bucketed by the workspace slug (ramdisk / shared store), and
[`PI_SUBAGENT_SESSION_SLUG`](#environment-variables) pins that slug so the tree survives a workspace rename/move.

Mirrors Claude Code's per-`Task` session files so the user can audit, resume, or fork a delegated run. The parent
session also records a `subagent-run` custom entry carrying stop reason, token counts, cost, and the child session file
path - so `/fork` / `/tree` / `session-usage.ts` can reference it after the fact.

On startup and shutdown, worktree recovery requires ownership metadata proving a same-host owner process is dead. A
branch-name prefix alone never authorizes removal. Live, unknown-owner, dirty, and uncertain checkouts are preserved;
branches containing child commits are never force-deleted. Normal completion removes only the current owner's clean
checkout. Preserved paths and recovery branches appear in `details.workspace` and text answers. With
`returnFormat: "json"`, recovery notices are not appended to the JSON answer.

Child session files older than [`PI_SUBAGENT_RETAIN_DAYS`](#environment-variables) days (default 30) are also swept.

## Statusline integration

Subagent state is owned by this extension and surfaced via `ctx.ui.setStatus('subagent', …)`. The custom
[`statusline.ts`](./statusline.md) already renders extension statuses on line 3 - no changes there. Formats:

```text
subagent:explore ⏳ M(2):↑320/↻ 2.1k/↓180 R 87% $0.004 ctx:8% model:qwen3-6-35b-a3b
subagent:explore ✓ 3 turns ↑1.2k ↻ 5.4k ↓410 $0.013 4.2s
subagent: 2/3 done · 1 running · $0.021
```

Completed-run status lingers for [`PI_SUBAGENT_STATUS_LINGER_MS`](#environment-variables) (default 5000) before
clearing. Shared formatters (`fmtSi`, `fmtCost`, cache-hit ratio) live in
[`lib/node/pi/token-format.ts`](../../../lib/node/pi/token-format.ts) so the statusline and subagent renderers stay in
lockstep.

## Commands

Argument parsing, USAGE text, and the completion spec live in [`usage.ts`](../../../lib/node/pi/subagent/usage.ts).
Every subcommand re-scans the agent directories first (this never changes the `subagent` tool description); unknown
arguments print the USAGE text.

- `/agents` (alias `/agents running`) - open the **Running sub-agents** live overlay (auto-refresh every 1s). Each row
  block shows `<handle> <agent> <state> <elapsed> turn N/max`, a tokens line, a context-usage bar, model, and per-tool
  call counts (`read(7) · grep(3) · bash(1)`). Below the row list, a preview block summarises the highlighted child and
  tails a bounded ring (default 64 entries) of structured-event activity: `→ <tool>  <args>` / `← <result>` for tool
  calls, `▌ <…>` while an assistant message is streaming, plus retry / compaction one-liners. Follow-mode is on by
  default for live children; press `f` to freeze. Terminal children fall back to reading the child's on-disk JSONL
  transcript via `tailJsonl(...)`. The child list is windowed to the terminal height (keeping the highlighted child in
  view) above the pinned detail block, whose activity-tail budget shrinks on short terminals. Escape closes. Without a
  UI (print / RPC modes) it prints a flat list instead.
- `/agents list` - open the **Loaded sub-agents** overlay: a navigable row list (↑/↓) with a selection-driven preview
  block below the rule (path, tools / model / maxTurns / timeout / isolation, then the full description). The row list
  is windowed to the terminal height (keeping the highlighted agent in view, with `↑ N more` / `↓ N more` indicators)
  above the pinned preview. Escape closes.
- `/agents show <name>` - print the full frontmatter + body of a single agent (useful for confirming an override took
  effect).
- `/agents reload` - re-scan the three agent directories and report how many agents loaded (plus any load warnings).

Both overlays follow the same `─── Title ───…─── chip ───` rule style as `/todos` and share the pure helpers in
[`lib/node/pi/subagent/format.ts`](../../../lib/node/pi/subagent/format.ts) +
[`lib/node/pi/subagent/activity.ts`](../../../lib/node/pi/subagent/activity.ts) so the on-screen rendering can be unit-
tested without spinning pi up.

## Per-call overrides

The `subagent` tool accepts a few optional fields that override the agent definition for a single dispatch. Use these
sparingly - the agent frontmatter defaults are the right starting point, and the global ceilings (the
[config file](#config-file) and its `PI_SUBAGENT_*` env layer) still apply.

| Field           | Type                          | Effect                                                                                                                                                                                                                                                                                                   |
| --------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelOverride` | `string` (`provider/modelId`) | Replaces the agent's `model` for this dispatch. Falls back to the config `model` (project > user > `PI_SUBAGENT_MODEL`) if unset.                                                                                                                                                                        |
| `maxTurns`      | `integer` (1–1000)            | Replaces the agent's `maxTurns` for this dispatch. Lifts the cap above the agent default when delegating a known multi-file implementation; can also lower it. The config `maxTurns` (project > user > `PI_SUBAGENT_MAX_TURNS`) still acts as the global ceiling - resolved cap is `min(maxTurns, cap)`. |
| `timeoutMs`     | `integer` (≥ 1000)            | Replaces the agent's `timeoutMs` for this dispatch (e.g. `1200000` for a 20 min implementation run on a 300 s agent). Clamped (with a warning notify) to the config `maxTimeoutMs` ceiling (default `3600000` = 1 h); `PI_SUBAGENT_TIMEOUT_MS` remains the global hard cap over the result.              |
| `fork`          | `boolean`                     | Fork the parent conversation into the child for this dispatch (see [Fork mode](#fork-mode)). Overrides the agent's `context` field. Downgrades to a fresh start (with a notify) when the parent session is not persisted to disk.                                                                        |

## Fork mode

By default a sub-agent starts with a blank context: it sees only its own persona (the frontmatter body) plus the `task`
string. Fork mode (`context: inherit` in frontmatter, or `fork: true` per call) instead seeds the child with the
parent's **full conversation history** via pi's `SessionManager.forkFrom`, so the child sees everything the parent saw.
The parent transcript still receives only the child's final answer.

Use it when the task depends on context already in the conversation that would be tedious to restate (a long file the
parent already read, a design discussed across several turns).

Fork mode trades the agent definition's curated model and tools for inherited conversation context. A forked child:

- **runs on the parent model** - any `model` / `modelOverride` is ignored (with a notify);
- **uses pi's default tool set**, not the agent's curated `tools` allowlist;
- **injects the persona as the first user message** rather than appending it to the system prompt.

The agent's `bashAllow` / `bashDeny` / `writeRoots` / `requestOptions` gates still apply. Fresh and forked children use
the same cancellation, budget, and disposal controller. Prompt-cache reuse is not guaranteed: child tools and
system-prompt construction may differ from the parent's full extension stack, even with the same model.

Recursive spawning is disabled: children run with `noExtensions: true` (the `subagent` / `subagent_send` tools are never
registered in a child) and those tool names are additionally passed to `excludeTools`, so no sub-agent (forked or fresh)
can ever fan out further.

## Config file

`model`, `maxTurns`, `concurrency`, and `maxTimeoutMs` are settable per-project (`<cwd>/.pi/subagent.json`) and per-user
(`~/.pi/agent/subagent.json`) in addition to the `PI_SUBAGENT_*` env vars. Layers, lowest precedence first: built-in
defaults → `PI_SUBAGENT_*` env knobs → user config → project config. A per-call tool override (`modelOverride` /
`maxTurns` / `timeoutMs`) still wins over all of these, so the full resolution order is:

```text
per-call param > project config > user config > env knob > built-in default
```

(Pure logic in [`../../../lib/node/pi/subagent/config.ts`](../../../lib/node/pi/subagent/config.ts).)

| Key            | Type                          | Default   | Effect                                                                                                         |
| -------------- | ----------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `model`        | `string` (`provider/modelId`) | (unset)   | Global model override applied to every child (env: `PI_SUBAGENT_MODEL`).                                       |
| `maxTurns`     | integer ≥ 1                   | (unset)   | Global max-turns ceiling fed to `min(perCall ?? agentDefault, cap)` (env: `PI_SUBAGENT_MAX_TURNS`).            |
| `concurrency`  | integer (clamped 1–8)         | `4`       | Max concurrent children (env: `PI_SUBAGENT_CONCURRENCY`). Captured at load; changing it needs `/reload`.       |
| `maxTimeoutMs` | integer ≥ 1                   | `3600000` | Ceiling on a per-call `timeoutMs` (env: `PI_SUBAGENT_MAX_TIMEOUT_MS`). Agent frontmatter is not bounded by it. |

```jsonc
// <cwd>/.pi/subagent.json - this project fans out to a cheaper local model, lower turn budget
{
  "model": "ollama/qwen2.5-coder",
  "maxTurns": 12,
}
```

## Worktree caveat

`isolation: "worktree"` severs continuity with the parent's `memory` / `scratchpad` / `todo` state because
`cwdSlug(worktreePath)` differs from `cwdSlug(parentCwd)`. A worktree is an isolated checkout, not an OS security
boundary. If a child needs project-scoped state, keep `isolation: "shared-cwd"` and explicitly provide child-safe tools.

## Environment variables

- `PI_SUBAGENT_DISABLED=1` - skip the extension entirely.
- `PI_SUBAGENT_DISABLE_PARENT_PROMPT=1` - disable the [parent-UI approval bridge](#parent-ui-approval-bridge). Children
  then fall back to `PI_BASH_PERMISSIONS_DEFAULT` / `PI_FILESYSTEM_DEFAULT` (default deny) for gated tool calls instead
  of prompting the parent. Read on `session_start`, so a change needs `/reload`.
- `PI_SUBAGENT_DEBUG=1` - surface every child lifecycle event via `ctx.ui.notify`.
- `PI_SUBAGENT_CONCURRENCY=N` - max concurrent children (default `4`, floor `1`, ceiling `8`). Also settable via the
  [config file](#config-file)'s `concurrency`, which wins over this env var.
- `PI_SUBAGENT_NO_PERSIST=1` - use `SessionManager.inMemory()` instead of disk-backed child sessions.
- `PI_SUBAGENT_SESSION_ROOT=<path>` - override the default base (the parent's effective session dir) with an explicit
  child-session root, bucketed by the workspace slug (ramdisk, etc.). Unset = child transcripts nest under
  `sessionManager.getSessionDir()`, so they follow `--session-dir` automatically.
- `PI_SUBAGENT_SESSION_SLUG=<slug>` - pin the workspace-slug bucket segment (only used with `PI_SUBAGENT_SESSION_ROOT`)
  to a fixed, cwd-independent value so the child-session tree survives a workspace rename/move.
- `PI_SUBAGENT_RETAIN_DAYS=N` - retain child session files for N days before the startup sweep deletes them (default
  `30`).
- `PI_SUBAGENT_STATUS_LINGER_MS=N` - keep completed status visible for N ms (default `5000`).
- `PI_SUBAGENT_MAX_TURNS=N` - global max-turns cap. Wins over per-agent settings. Also settable via the
  [config file](#config-file)'s `maxTurns`, which wins over this env var.
- `PI_SUBAGENT_TIMEOUT_MS=N` - global wall-clock hard cap in ms. Wins over per-agent settings and per-call `timeoutMs`.
- `PI_SUBAGENT_MAX_TIMEOUT_MS=N` - ceiling in ms on a per-call `timeoutMs` (default `3600000`). Also settable via the
  [config file](#config-file)'s `maxTimeoutMs`, which wins over this env var.
- `PI_SUBAGENT_MODEL=provider/id` - global model override applied to every child. Also settable via the
  [config file](#config-file)'s `model`, which wins over this env var.
- `PI_SUBAGENT_BG_MAX=N` - max entries retained in the background-children registry; older completed entries are pruned
  past this cap (default `32`). Parsed as a positive integer; non-positive or unparseable values fall back to the
  default.
- `PI_SUBAGENT_BG_SHUTDOWN_MS=N` - wall-clock budget, ms, for the `session_shutdown` drain that aborts and disposes
  running children and pending setup (default `2000`). After the deadline, remaining child event runners are disposed
  best-effort and late completions are isolated from the next session. Parsed as a positive integer; non-positive or
  unparseable values fall back to the default.

## Hot reload

Edit [`extensions/subagent.ts`](./subagent.ts) or the helpers under
[`lib/node/pi/subagent/`](../../../lib/node/pi/subagent) and run `/reload` inside an interactive pi session. New or
edited `.md` files under any of the three agent directories are picked up on the next `/reload`, when any `/agents`
subcommand runs (each rescans before acting), or lazily: a `subagent` call naming an unknown agent re-scans once before
failing, so a `.md` dropped in mid-session is callable without `/reload`. If the name is still unknown the error lists
the loaded agents and points at `/agents list` (load warnings) and `/reload`.

The `subagent` tool's LLM-visible description (the agent list in the tool schema) is built when the extension loads.
pi's `getAllTools()` throws during extension loading, so that first scan validates `tools` permissively
(`resolveKnownToolNames` in [`loader.ts`](../../../lib/node/pi/subagent/loader.ts)) - names and descriptions are what
the schema needs. The description is then fixed for the life of the extension instance: it is never re-registered on
`session_start`, resume, or a lazy re-scan, because changing a tool schema mid-session invalidates the prompt cache.
`session_start` still re-scans against the real tool registry and `ctx.cwd`, but that only updates the agent lookup.
Mid-session additions found by the lazy re-scan are callable but not listed in the description until `/reload` (or a new
pi process) rebuilds it.
