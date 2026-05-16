# Codex CLI config

Configuration and custom tooling for the [Codex CLI](https://github.com/openai/codex).

## Files

- [`config.toml`](#configtoml) - mirrors `~/.codex/config.toml`.
- [`session-usage.ts`](#session-usagets) - CLI that walks `~/.codex/sessions/` and summarizes transcript token/tool
  usage.

## `config.toml`

Reference Codex settings: default model, reasoning effort, file opener, `[features]` toggles, `[tui]` status-line layout
and theme, and analytics/feedback opt-outs.

## `session-usage.ts`

CLI that scans `~/.codex/sessions/` for session transcripts and prints summaries.

### Usage

```sh
# List every Codex session rooted under $PWD.
./session-usage.ts list

# Filter to sessions under a specific directory tree.
./session-usage.ts list --project ~/src/someproject

# Detailed single-session report (prefix match on the id is enough).
./session-usage.ts session 019d4aae
```

### Options

- **`--project, -p <path>`** - filter sessions by cwd tree. Defaults to `$PWD`.
- **`--user-dir, -u <dir>`** - alternate Codex profile root. Defaults to `~/.codex`.
- **`--sort <field>`** - `date` (default), `tokens`, `duration`, or `tools`.
- **`--limit, -n <N>`** - cap output to the top N sessions.
- **`--json`** - machine-readable JSON output.
- **`--no-color`** - disable ANSI colors.

### Columns and fields

The list / detail views include a `CONTEXT` column (and `Context (last turn)` row in detail) populated from the last
`token_count` event's `info.last_token_usage.input_tokens`. Codex already reports this as the total input sent to the
model for that turn (cached tokens included), so the column is the tokens the model saw on the most recently completed
turn - not a prediction of what the next request will send. Codex also stores `info.model_context_window`, exposed as
`context_window` in JSON output alongside `last_context_tokens`.
