# pi config

Configuration, custom extensions, skills, subagent definitions, and themes for
[pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). See the per-directory READMEs below for deep
reference on each area.

## Files

| Path                                                               | Purpose                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`extensions/`](./extensions/README.md)                            | Custom pi extensions (statusline, bash-permissions, todo, subagent, memory, iteration-loop, …) auto-loaded via `settings-baseline.json`.                                                                                                                                                                     |
| [`skills/`](./README-skills.md)                                    | Auto-loaded skills that teach WHEN to reach for each extension's tools (plan-first, memory-first, grep-before-read, iterate-until-verified, …).                                                                                                                                                              |
| [`agents/`](./agents/README.md)                                    | Subagent definitions dispatched by [`extensions/subagent.ts`](./extensions/subagent.ts) (critic, explore, plan, general-purpose, web-researcher, …).                                                                                                                                                         |
| [`modes/`](./modes/README.md)                                      | Persona overlay definitions discovered by [`extensions/mode.ts`](./extensions/mode.ts). `/mode <name>` activates a named mode (planner, chat, knowledge-base, journal, …) for the parent session, scoping tools and writes.                                                                                  |
| [`themes/`](./themes)                                              | JSON themes (e.g. [`solarized-dark.json`](./themes/solarized-dark.json), [`solarized-light.json`](./themes/solarized-light.json)) loadable by name.                                                                                                                                                          |
| [`settings-baseline.json`](#settings-baselinejson)                 | Reference baseline for `~/.pi/agent/settings.json`. Wires up `extensions` / `skills` / `agents` / `themes`.                                                                                                                                                                                                  |
| [`presets.json`](./presets.json)                                   | Named bundles of provider/model/thinking-level/extension toggles, consumed by [`extensions/preset.ts`](./extensions/preset.ts) and `/preset`.                                                                                                                                                                |
| [`models-example.json`](./models-example.json)                     | Example custom-model definitions (OpenAI-compatible endpoints, local llama-cpp, etc.).                                                                                                                                                                                                                       |
| [`bash-permissions-example.json`](./bash-permissions-example.json) | Baseline read-only allowlist for the [`bash-permissions`](./extensions/bash-permissions.md) extension. Copy to `~/.pi/bash-permissions.json` or `<repo>/.pi/bash-permissions.json`. Covered by [`tests/config/pi/bash-permissions-example.spec.ts`](../../tests/config/pi/bash-permissions-example.spec.ts). |
| [`session-usage.ts`](#session-usagets)                             | CLI that walks `~/.pi/agent/sessions/` and summarizes session token / cost / tool usage.                                                                                                                                                                                                                     |

Pi auto-discovers `extensions/`, `skills/`, `agents/`, and `themes/` via the matching arrays in
[`settings-baseline.json`](./settings-baseline.json). Paths accept `~`, absolute paths, and globs. See the
[pi settings docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md#resources) for
the full list of resource directories pi scans — the settings entries are additive to the built-in
`~/.pi/agent/{extensions,themes}` and `.pi/{extensions,themes}` auto-discovery paths, not a replacement.

## `settings-baseline.json`

Reference baseline config for pi. Copy (or merge) into `~/.pi/agent/settings.json` — pi manages a few runtime-only keys
there (e.g. `lastChangelogVersion`) that are intentionally omitted from the baseline.

The `extensions` / `skills` / `agents` / `themes` arrays are what wire the directories in this repo into pi; everything
else is preference (default provider/model, default thinking level, theme selection, telemetry opt-out).

## `session-usage.ts`

CLI that walks `~/.pi/agent/sessions/` and summarizes session token / cost / tool usage. Same UX as
[`../claude/session-usage.ts`](../claude/session-usage.ts) and [`../codex/session-usage.ts`](../codex/session-usage.ts)
— shares the rendering / arg-parsing harness under [`../../lib/node/ai-tooling/`](../../lib/node/ai-tooling).

### Commands

- `list` — all sessions for the current project (cwd). Default.
- `session <uuid>` — detailed single-session report. Accepts a UUID prefix.
- `totals` — usage bucketed by day or week. Scopes to the current project when `--project` is given; otherwise
  aggregates across every project.

### Options

- `--project, -p <path>` — filter by project directory (default: `$PWD`).
- `--user-dir, -u <dir>` — pi agent dir (default: `~/.pi/agent`).
- `--json` — machine-readable output.
- `--sort <field>`, `--limit, -n <N>`, `--group-by, -g <day|week>`, `--no-color` — standard across all adapters.

### Data source

Pi records per-message `usage.cost.total` on every assistant message, so unlike the Claude and Codex adapters this one
does **not** fetch or cache the LiteLLM pricing table — costs come straight from the session file. `--no-cost` and
`--refresh-prices` are accepted for interface parity with the other tools but have no effect.

### Columns and fields

The list / detail views include a `CONTEXT` column (and `Context (last turn)` row in detail) showing the input tokens
sent to the model on the most recently completed assistant turn (`input + cacheRead + cacheWrite`; falls back to
`totalTokens - output` when the provider omitted the breakdown). It is **not** a prediction of the next request — any
post-assistant user text and tool results get added on top before the next turn. JSON output exposes the same value as
`last_context_tokens`.

### Subagents

The [`subagent` extension](./extensions/subagent.ts) writes each child transcript next to its parent at
`~/.pi/agent/sessions/<parent-cwd-slug>/subagents/<parent-session-id>/<timestamp>_<child-session-id>.jsonl`, and emits a
matching `type:"custom", customType:"subagent-run"` audit entry in the parent session with the child's agent name, the
task string, the stop reason, and the child session id. `session-usage.ts` picks both up:

- `list` / `totals` populate the `AGENTS` column with the child file count; parent-session token totals stay parent-only
  (matching claude / codex semantics — child tokens never double-count into parent rollups).
- `session <uuid>` parses every child `.jsonl` for its own tokens, cost, model, and tool breakdown, and enriches the row
  with `agent_label` (= `agent`), `role` (= `handle`, e.g. `sub_explore_1`), and `description` (= truncated `task`) from
  the matching `subagent-run` entry.
- Orphaned child transcripts (crash-leftovers without a recorded parent entry) still render — the agent label is just
  empty.

## Related docs

- [extensions/README.md](./extensions/README.md) — per-extension index and deep references.
- [README-skills.md](./README-skills.md) — skill index and policy summary.
- [agents/README.md](./agents/README.md) — subagent definitions.
- [../claude/README.md](../claude/README.md) — sibling Claude Code config.
- [../codex/README.md](../codex/README.md) — sibling Codex CLI config.
- [pi settings docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md) — upstream
  settings reference.
