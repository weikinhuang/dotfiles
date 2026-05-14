# `subagent.ts`

Claude Code `Task` / opencode / codex-style in-process sub-agent delegation. The parent LLM calls a single
`subagent(agent, task)` tool; the extension spins up a throwaway child `AgentSession` with its own context, tool
allowlist, and — optionally — a dedicated model or a git-worktree sandbox. The parent only sees the child's final
answer; intermediate tool churn stays in the child's own session file.

## Why

Small models hoarding the parent's context on broad exploration (“read 40 files and summarize”) is a common failure mode
that [`tool-output-condenser`](./tool-output-condenser.md) can only partially address. This extension shifts the entire
exploration subtree into a child session so the parent's context window stays clean. It composes with
[`scratchpad`](./scratchpad.md) and [`todo`](./todo.md): the parent keeps its plan + notebook while the child handles
the leg-work.

## What the tool does

Registers one tool (`subagent`) with `executionMode: "parallel"` and one command (`/agents`).

- **Single call, parallel fan-out.** The parent model invokes `subagent` once per delegation; to fan out, it calls the
  tool multiple times in one assistant turn. An in-process semaphore caps concurrency at
  [`PI_SUBAGENT_CONCURRENCY`](#environment-variables) (default 4, hard ceiling 8).
- **No nested delegation.** The default agent definitions do NOT include `subagent` in their tool lists — Claude Code,
  opencode, and codex all make the same choice. Prevents runaway fan-out.
- **Context isolation.** Child starts with no parent chat history. Only the workspace's `AGENTS.md` / `CLAUDE.md` files
  and the agent definition's system-prompt body are injected.
- **Guardrail inheritance.** `bash-permissions.json` / `protected-paths.json` rule layers apply in the child because
  both extensions re-read them on every tool call. The **session allowlist** (in-memory approvals) does NOT cross the
  boundary — fresh child, fresh approvals.
- **Parent never sees intermediate tool output.** The child's own session file records every call; the parent's
  `tool_result` carries only the final answer text. A collapsible `subagent-run` message in the parent transcript
  renders the one-liner status with an expand-to-markdown view of the answer.

## Agent definitions

Markdown files with YAML frontmatter, discovered across three priority layers (higher wins by `name`):

| Layer    | Path                            | Scope            |
| -------- | ------------------------------- | ---------------- |
| 1 (low)  | `~/.dotfiles/config/pi/agents/` | Global defaults  |
| 2        | `~/.pi/agents/`                 | User overrides   |
| 3 (high) | `<cwd>/.pi/agents/`             | Project override |

Frontmatter schema:

| Field                | Type                       | Default                  | Meaning                                                                                         |
| -------------------- | -------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `name`               | string (required)          | —                        | LLM-visible agent identifier. Must match `[a-z][a-z0-9-]*`.                                     |
| `description`        | string (required)          | —                        | Explains WHEN to delegate. Surfaced to the parent LLM in the tool description.                  |
| `tools`              | string[]                   | `[read, grep, find, ls]` | Allowlist of built-in + extension tool names. Unknown entries drop with a startup warning.      |
| `model`              | `inherit` \| `provider/id` | `inherit`                | Which model answers. `inherit` reuses the parent's current model.                               |
| `thinkingLevel`      | `off…xhigh`                | inherit                  | Clamped to the chosen model's capabilities.                                                     |
| `maxTurns`           | number                     | `20`                     | Hard cap on agent turns (enforced by counting `turn_end` + calling `child.abort()`).            |
| `timeoutMs`          | number                     | `180000`                 | Wall-clock cap — aborts the child session.                                                      |
| `isolation`          | `shared-cwd` \| `worktree` | `shared-cwd`             | `worktree` creates `.git/worktrees/pi-subagent-<uuid>/`; removed on completion or stale sweep.  |
| `appendSystemPrompt` | string                     | —                        | Extra text appended to pi's default system prompt, before the Markdown body. Rare escape hatch. |

Default agents shipped with the dotfiles:

- **`explore`** — read-only (`read, grep, find, ls`), `thinkingLevel: low`, `maxTurns: 12`. Use for "find X across the
  codebase" / "summarize what this module does".
- **`plan`** — same read-only toolkit, `thinkingLevel: medium`, `maxTurns: 16`. Turns a vague problem into a
  step-by-step implementation plan grounded in real files.
- **`general-purpose`** — full default tool set (`bash, read, write, edit, grep, find, ls`), `maxTurns: 20`. Catch-all
  when the subtask needs both reads and edits.

All three deliberately exclude `memory` from their tool lists — sub-agents should not be writing durable notes on behalf
of the user at the parent scope. Opt in per-agent by adding `memory` to its `tools` list.

## Session persistence

Each child invocation writes to its own on-disk session file:

```text
~/.pi/agent/sessions/<parent-cwd-slug>/subagents/<parent-session-id>/ <iso-timestamp>\_<child-session-id>.jsonl
```

Mirrors Claude Code's per-`Task` session files so the user can audit, resume, or fork a delegated run. The parent
session also records a `subagent-run` custom entry carrying stop reason, token counts, cost, and the child session file
path — so `/fork` / `/tree` / `session-usage.ts` can reference it after the fact.

On `session_start` (parent-crash recovery) AND `session_shutdown` (happy path) the extension sweeps stale
`pi-subagent-*` worktrees and deletes child session files older than [`PI_SUBAGENT_RETAIN_DAYS`](#environment-variables)
days (default 30).

## Statusline integration

Subagent state is owned by this extension and surfaced via `ctx.ui.setStatus('subagent', …)`. The custom
[`statusline.ts`](./statusline.md) already renders extension statuses on line 3 — no changes there. Formats:

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

- `/agents` (or `/agents list`) — list every loaded agent with its source layer + one-line description.
- `/agents show <name>` — print the full frontmatter + body of a single agent (useful for confirming an override took
  effect).

## Per-call overrides

The `subagent` tool accepts a few optional fields that override the agent definition for a single dispatch. Use these
sparingly — the agent frontmatter defaults are the right starting point, and the env-var ceilings (see
[Environment variables](#environment-variables)) always win.

| Field           | Type                          | Effect                                                                                                                                                                                                                                                          |
| --------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelOverride` | `string` (`provider/modelId`) | Replaces the agent's `model` for this dispatch. Falls back to `PI_SUBAGENT_MODEL` if unset.                                                                                                                                                                     |
| `maxTurns`      | `integer` (1–1000)            | Replaces the agent's `maxTurns` for this dispatch. Lifts the cap above the agent default when delegating a known multi-file implementation; can also lower it. `PI_SUBAGENT_MAX_TURNS` still acts as the global ceiling — resolved cap is `min(maxTurns, env)`. |

## Worktree caveat

`isolation: "worktree"` severs continuity with the parent's `memory` / `scratchpad` / `todo` state because
`cwdSlug(worktreePath)` differs from `cwdSlug(parentCwd)`. That's deliberate — the worktree is a sandbox. If a sub-agent
needs the parent's project-scoped memories, keep `isolation: "shared-cwd"`.

## Environment variables

- `PI_SUBAGENT_DISABLED=1` — skip the extension entirely.
- `PI_SUBAGENT_DEBUG=1` — surface every child lifecycle event via `ctx.ui.notify`.
- `PI_SUBAGENT_CONCURRENCY=N` — max concurrent children (default `4`, floor `1`, ceiling `8`).
- `PI_SUBAGENT_NO_PERSIST=1` — use `SessionManager.inMemory()` instead of disk-backed child sessions.
- `PI_SUBAGENT_SESSION_ROOT=<path>` — override `~/.pi/agent/sessions` as the child session root (ramdisk, etc.).
- `PI_SUBAGENT_RETAIN_DAYS=N` — retain child session files for N days before the startup sweep deletes them (default
  `30`).
- `PI_SUBAGENT_STATUS_LINGER_MS=N` — keep completed status visible for N ms (default `5000`).
- `PI_SUBAGENT_MAX_TURNS=N` — global max-turns cap. Wins over per-agent settings.
- `PI_SUBAGENT_TIMEOUT_MS=N` — global wall-clock cap in ms. Wins over per-agent settings.
- `PI_SUBAGENT_MODEL=provider/id` — global model override applied to every child.

## Hot reload

Edit [`extensions/subagent.ts`](./subagent.ts) or the helpers under [`lib/node/pi/subagent-*.ts`](../../../lib/node/pi)
and run `/reload` inside an interactive pi session. New or edited `.md` files under any of the three agent directories
are picked up on the next `/reload` (or when any `/agents` subcommand runs — the command rescans before listing).

**Caveat:** the `subagent` tool's LLM-visible description (the list of available agents baked into the tool schema) is
captured at `registerTool` time. `/reload` re-runs the extension factory and so refreshes it; a `.md` file dropped in
mid-session without a `/reload` is usable via `/agents` and callable via `subagent` (the tool looks up agents by name
dynamically), but the parent model won't see the new agent in the tool-description enum until the next `/reload`.
