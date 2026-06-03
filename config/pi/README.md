# pi config

Configuration, custom extensions, skills, subagent definitions, and themes for
[pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). See the per-directory READMEs below for deep
reference on each area.

## Files

| Path                                                               | Purpose                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`extensions/`](./extensions/README.md)                            | Custom pi extensions (statusline, bash-permissions, todo, subagent, memory, iteration-loop, …) auto-loaded via `settings-baseline.json`.                                                                                                                                                                           |
| [`skills/`](./README-skills.md)                                    | Auto-loaded skills that teach WHEN to reach for each extension's tools (plan-first, memory-first, grep-before-read, iterate-until-verified, …).                                                                                                                                                                    |
| [`agents/`](./agents/README.md)                                    | Subagent definitions dispatched by [`extensions/subagent.ts`](./extensions/subagent.ts) (critic, explore, plan, general-purpose, web-researcher, …).                                                                                                                                                               |
| [`personas/`](./personas/README.md)                                | Persona overlay definitions discovered by [`extensions/persona.ts`](./extensions/persona.ts). `/persona <name>` activates a named persona (planner, chat, knowledge-base, journal, …) for the parent session, scoping tools and writes.                                                                            |
| [`themes/`](./themes)                                              | JSON themes (e.g. [`solarized-dark.json`](./themes/solarized-dark.json), [`solarized-light.json`](./themes/solarized-light.json)) loadable by name.                                                                                                                                                                |
| [`settings-baseline.json`](#settings-baselinejson)                 | Reference baseline for `~/.pi/agent/settings.json`. Wires up `extensions` / `skills` / `agents` / `themes`.                                                                                                                                                                                                        |
| [`presets.json`](./presets.json)                                   | Named bundles of provider/model/thinking-level/extension toggles, consumed by [`extensions/preset.ts`](./extensions/preset.ts) and `/preset`.                                                                                                                                                                      |
| [`models-example.json`](./models-example.json)                     | Example custom-model definitions (OpenAI-compatible endpoints, local llama-cpp, etc.).                                                                                                                                                                                                                             |
| [`bash-permissions-example.json`](./bash-permissions-example.json) | Baseline read-only allowlist for the [`bash-permissions`](./extensions/bash-permissions.md) extension. Copy to `~/.pi/agent/bash-permissions.json` or `<repo>/.pi/bash-permissions.json`. Covered by [`tests/config/pi/bash-permissions-example.spec.ts`](../../tests/config/pi/bash-permissions-example.spec.ts). |
| [`hooks-example.json`](./hooks-example.json)                       | Annotated starter for the [`hooks`](./extensions/hooks.md) extension. Copy to `~/.pi/agent/hooks.json` or `<repo>/.pi/hooks.json`. Each event class (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`) ships with one commented-out example.                                                                        |
| [`context-trim-example.json`](./context-trim-example.json)         | Threshold config for the [`context-trim`](./extensions/context-trim.md) extension. Copy to `~/.pi/agent/context-trim.json` or `<repo>/.pi/context-trim.json`.                                                                                                                                                      |
| [`tool-collapse-example.json`](./tool-collapse-example.json)       | Threshold + auto-collapse config for the [`tool-collapse`](./extensions/tool-collapse.md) extension. Copy to `~/.pi/agent/tool-collapse.json` or `<repo>/.pi/tool-collapse.json`.                                                                                                                                  |
| [`image-ref-example.json`](./image-ref-example.json)               | Knobs for the [`image-ref`](./extensions/image-ref.md) extension (`maxImages`, `autoResize`, `maxFileBytes`). Copy to `~/.pi/agent/image-ref.json` or `<repo>/.pi/image-ref.json`.                                                                                                                                 |
| [`session-usage.ts`](#session-usagets)                             | CLI that walks `~/.pi/agent/sessions/` and summarizes session token / cost / tool usage.                                                                                                                                                                                                                           |

Pi auto-discovers `extensions/`, `skills/`, `agents/`, and `themes/` via the matching arrays in
[`settings-baseline.json`](./settings-baseline.json). Paths accept `~`, absolute paths, and globs. See the
[pi settings docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md#resources) for
the full list of resource directories pi scans - the settings entries are additive to the built-in
`~/.pi/agent/{extensions,themes}` and `.pi/{extensions,themes}` auto-discovery paths, not a replacement.

## `settings-baseline.json`

Reference baseline config for pi. Copy (or merge) into `~/.pi/agent/settings.json` - pi manages a few runtime-only keys
there (e.g. `lastChangelogVersion`) that are intentionally omitted from the baseline.

The `extensions` / `skills` / `agents` / `themes` arrays are what wire the directories in this repo into pi; everything
else is preference (default provider/model, default thinking level, theme selection, telemetry opt-out).

## `session-usage.ts`

CLI that walks `~/.pi/agent/sessions/` and summarizes session token / cost / tool usage. Same UX as
[`../claude/session-usage.ts`](../claude/session-usage.ts) and [`../codex/session-usage.ts`](../codex/session-usage.ts)

- shares the rendering / arg-parsing harness under [`../../lib/node/ai-tooling/`](../../lib/node/ai-tooling).

### Commands

- `list` - all sessions for the current project (cwd). Default.
- `session <uuid>` - detailed single-session report. Accepts a UUID prefix.
- `totals` - usage bucketed by day or week. Scopes to the current project when `--project` is given; otherwise
  aggregates across every project.

### Options

- `--project, -p <path>` - filter by project directory (default: `$PWD`).
- `--user-dir, -u <dir>` - pi agent dir (default: `~/.pi/agent`).
- `--json` - machine-readable output.
- `--sort <field>`, `--limit, -n <N>`, `--group-by, -g <day|week>`, `--no-color` - standard across all adapters.

### Data source

Pi records per-message `usage.cost.total` on every assistant message, so unlike the Claude and Codex adapters this one
does **not** fetch or cache the LiteLLM pricing table - costs come straight from the session file. `--no-cost` and
`--refresh-prices` are accepted for interface parity with the other tools but have no effect.

### Columns and fields

The list / detail views include a `CONTEXT` column (and `Context (last turn)` row in detail) showing the input tokens
sent to the model on the most recently completed assistant turn (`input + cacheRead + cacheWrite`; falls back to
`totalTokens - output` when the provider omitted the breakdown). It is **not** a prediction of the next request - any
post-assistant user text and tool results get added on top before the next turn. JSON output exposes the same value as
`last_context_tokens`.

### Subagents

The [`subagent` extension](./extensions/subagent.ts) writes each child transcript next to its parent at
`~/.pi/agent/sessions/<parent-cwd-slug>/<parent-session-id>/subagents/<timestamp>_<child-session-id>.jsonl`, and emits a
matching `type:"custom", customType:"subagent-run"` audit entry in the parent session with the child's agent name, the
task string, the stop reason, and the child session id. `session-usage.ts` picks both up:

- `list` / `totals` populate the `AGENTS` column with the child file count; parent-session token totals stay parent-only
  (matching claude / codex semantics - child tokens never double-count into parent rollups).
- `session <uuid>` parses every child `.jsonl` for its own tokens, cost, model, and tool breakdown, and enriches the row
  with `agent_label` (= `agent`), `role` (= `handle`, e.g. `sub_explore_1`), and `description` (= truncated `task`) from
  the matching `subagent-run` entry.
- Orphaned child transcripts (crash-leftovers without a recorded parent entry) still render - the agent label is just
  empty.

## Sandboxing in action

Three composable security gates ship enabled by default in [`settings-baseline.json`](./settings-baseline.json):

1. [`bash-permissions`](./extensions/bash-permissions.md) - regex / UI gate at the LLM tool-call layer.
2. [`filesystem`](./extensions/filesystem.md) - in-process gate for `read` / `write` / `edit` calls.
3. [`sandbox`](./extensions/sandbox.md) - kernel-level sandbox (`sandbox-exec` on macOS, `bubblewrap` on Linux) that
   wraps every bash subprocess via
   [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime).

The shipped [`bash-permissions-example.json`](./bash-permissions-example.json) baseline covers the read-only forge-CLI
surface for `gh` and `glab` (repo / pr / mr / issue / ci / run / release / workflow views and lists, `auth status`,
`config get`, plus a GET-only regex gate for `gh api` / `glab api`). Account-scoped mutations - repo delete, auth
login/logout, secret / variable writes, extension installs - are denied outright; project-scoped mutations like
`gh pr create` or `glab mr merge` are intentionally left out so they hit the approval prompt and can be opted into per
repo via `<repo>/.pi/bash-permissions.json`.

### First run

```text
$ pi
… sandbox: deps OK (sandbox-exec, ripgrep)
… filesystem: defaults loaded; project policy at .pi/filesystem.json absent
🛡️  ⚡    bash-permissions: auto mode off    filesystem: 0 rules    sandbox: wrapped

You: please run the tests

[pi opens the bash-permissions dialog the first time it sees `npm test`]
  → Allow once
  → Allow `npm test` for this session
  → Always allow `npm test` (project)   ← writes .pi/bash-permissions.json
  → Deny
  → Deny with feedback…

[sandbox wraps the approved command. The kernel blocks any escape - if the
 model later tries `cat ~/.ssh/id_rsa`, the read EPERMs at the syscall layer
 even though bash-permissions never sees that path inside the wrapper.]
```

### Statusline badge states

| Badge     | Meaning                                                                                |
| --------- | -------------------------------------------------------------------------------------- |
| `🛡️`      | sandbox on, deps OK, every bash subprocess wrapped                                     |
| `⚡ 🛡️`   | auto-mode on AND sandbox on (defense-in-depth visible at a glance)                     |
| (hidden)  | session bypass via `/sandbox-disable` - cleared on `session_shutdown`                  |
| `🛡️ ?`    | identity-wrap because deps are missing or the platform is unsupported - run `/sandbox` |
| `🛡️ ·off` | bypassed via `PI_SANDBOX_DISABLED=1`                                                   |

### When something blocks

- The `/sandbox` slash command prints active config, dependency status, proxy ports, and the 10 most-recent violations.
- `/sandbox-violations [--net|--fs]` dumps the JSONL audit log at `~/.pi/agent/sandbox-violations.log`.
- On a sandboxed bash failure, the model sees ASRT's annotated stderr (prefixed with
  `⚠️ sandbox blocked this operation:`) instead of an opaque `EPERM` / `EROFS` - it knows to suggest
  `/sandbox-allow <host>` or a wider `write.allow.paths`.
- The bg-bash extension routes through the same wrap, so backgrounded jobs (`npm run dev`, watchers, dev servers) run
  under the kernel sandbox too; `process.kill(-pid, sig)` still reaps the wrapped child cleanly on both platforms.

### Running `pi -p` in CI

See the ["Running pi -p in CI" section](./extensions/sandbox.md#running-pi--p-in-ci) of the sandbox deep-doc - three
escalation rungs from pre-seeded `.pi/sandbox.json` to `PI_SANDBOX_DISABLED=1` for ephemeral containers.

## Related docs

- [extensions/README.md](./extensions/README.md) - per-extension index and deep references.
- [README-skills.md](./README-skills.md) - skill index and policy summary.
- [agents/README.md](./agents/README.md) - subagent definitions.
- [../claude/README.md](../claude/README.md) - sibling Claude Code config.
- [../codex/README.md](../codex/README.md) - sibling Codex CLI config.
- [pi settings docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md) - upstream
  settings reference.
