# opencode config

Configuration and custom tooling for [opencode](https://opencode.ai) v2.

## Files

- [`opencode.jsonc`](#opencodejsonc) - mirrors `~/.config/opencode/opencode.jsonc`.
- [`cli-baseline.json`](#cli-baselinejson) - mirrors `~/.config/opencode/cli.json` (TUI settings).
- [`session-usage.ts`](#session-usagets) - CLI that reads the opencode SQLite database and summarizes session token /
  tool usage.

The shell wrapper and completion live in [`plugins/30-opencode.sh`](../../plugins/30-opencode.sh).

## `opencode.jsonc`

Reference settings on the v2 schema (`https://opencode.ai/config.json`). Copy or merge it into
`~/.config/opencode/opencode.jsonc` by hand, the same way the Claude Code and Codex baselines are installed; for a named
profile, the target is `<profile dir>/opencode.jsonc` (see [Profiles](#profiles)).

- `share: "disabled"` and `update: "notify"` keep sessions local and leave upgrades to `npm`.
- `permissions` is an ordered rule list where the last matching rule wins. opencode appends these rules after every
  built-in agent's own rules, so they override the built-in "allow everything" default:
  1. `shell` asks for every command by default.
  2. The read-only command allowlist mirrors `permissions.allow` in
     [`config/claude/settings-baseline.json`](../claude/settings-baseline.json) (`Bash(git status *)` becomes
     `{ "action": "shell", "resource": "git status *", "effect": "allow" }`). A pattern ending in space-star such as
     `git status *` also matches the bare `git status`. Keep both lists in sync when adding entries.
  3. `read` denies for `*.env`, `*.env.*`, and `*.envrc` come last, mirroring Claude's `Read(./.env*)` denies.
- `model` and `providers` are intentionally absent: they are per-machine, so set them in the live file only.
- MCP servers and npm plugins are out of scope for now and are not part of the baseline.

Check what opencode actually loaded with `opencode debug config` (merged sources) and `opencode debug agents` (each
agent's effective permission list).

## `cli-baseline.json`

TUI settings on the v2 CLI schema (`https://opencode.ai/v2/cli.json`): the Solarized theme in dark mode, matching the
Codex and pi themes. Copy it to `<config dir>/cli.json`.

## Profiles

`opencode -u <name> ...` runs opencode against `${XDG_CONFIG_HOME:-$HOME/.config}/opencode-<name>/`, created on first
use. A profile is fully isolated, like the `claude`, `codex`, and `pi` wrappers:

- `OPENCODE_CONFIG_DIR` points at the profile dir (config, `AGENTS.md`, `cli.json`, `service.json`).
- `OPENCODE_DB` points at `<profile dir>/opencode.db`, which holds sessions and stored credentials, so each profile logs
  in separately.
- `XDG_STATE_HOME` points at `<profile dir>/state`. opencode v2 runs every command through one background service
  registered under `$XDG_STATE_HOME/opencode/` on a fixed port, so without this a profile would silently reuse the
  default profile's server.
- On first use the wrapper runs `opencode service set port <n>` with a stable per-profile port (49400-49899, derived
  from the name) so the profile's service does not collide with the default one on 49374. Change it with
  `opencode -u <name> service set port <n>`.
- `OPENCODE_PROFILE_NAME` is exported, and `<profile dir>/env` is sourced if present.

Tools the agent runs inherit the profile's `XDG_STATE_HOME`. Without `-u`, the wrapper only sources
`${OPENCODE_CONFIG_DIR:-~/.config/opencode}/env` and changes nothing else.

## `session-usage.ts`

CLI that reads `opencode.db` and prints session summaries. Only the v2 schema (`session_v2` and `session_message`
tables) is supported; older databases fail with an "opencode v2 database required" error.

### Usage

```sh
# List every opencode session rooted under $PWD.
./session-usage.ts list

# Filter to sessions under a specific directory tree.
./session-usage.ts list --project ~/src/someproject

# Detailed single-session report (prefix match on the id is enough).
./session-usage.ts session ses_2a0b

# Sessions from a named profile.
./session-usage.ts list --user-dir ~/.config/opencode-work
```

### Options

- **`--project, -p <path>`** - filter sessions by directory tree. Defaults to `$PWD`.
- **`--user-dir, -u <dir>`** - directory holding `opencode.db`. Defaults to `$OPENCODE_DB` when set, else
  `${XDG_DATA_HOME:-~/.local/share}/opencode`. Pass a profile dir to read that profile's sessions.
- **`--sort <field>`** - `date` (default), `tokens`, `duration`, or `tools`.
- **`--limit, -n <N>`** - cap output to the top N sessions.
- **`--json`** - machine-readable JSON output.
- **`--no-color`** - disable ANSI colors.

### Columns and fields

Turns count `user` messages; token, cost, model, and tool counts come from `assistant` messages (`tool` items in each
message's `content`). The `CONTEXT` column is the last assistant message's `input + cache.read + cache.write`, the
tokens the model saw on the most recent turn. Subagent sessions (rows with a `parent_id`) roll up under their parent.
