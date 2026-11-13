# opencode config

Configuration and custom tooling for [opencode](https://opencode.ai) v2.

## Files

- [`opencode.jsonc`](#opencodejsonc) - mirrors `~/.config/opencode/opencode.jsonc`.
- [`cli-baseline.json`](#cli-baselinejson) - mirrors `~/.config/opencode/cli.json` (TUI settings).
- [`session-usage.ts`](#session-usagets) - CLI that reads the opencode SQLite database and summarizes session token /
  tool usage.
- [`plugins/`](./plugins/README.md) - opencode v2 plugins (ports of pi extensions), symlinked one by one into
  `~/.config/opencode/plugins/` by [`plugins/install.sh`](./plugins/install.sh).

The shell wrapper and completion live in [`plugins/30-opencode.sh`](../../plugins/30-opencode.sh).

## `opencode.jsonc`

Reference settings on the v2 schema (`https://opencode.ai/config.json`). `config/agents/sync.ts apply` installs it as
`~/.config/opencode/opencode.jsonc` (`OPENCODE_CONFIG_DIR` when set, so pointing it at `<profile dir>` covers a named
profile, see [Profiles](#profiles)). When the live file does not exist, the baseline is copied verbatim, comments
included. When it exists, the baseline is merged in (baseline keys win, the `permissions` array is replaced whole, other
live keys such as `model` and `providers` are kept) and the result is written as plain JSON, so comments in the live
file are lost; `diff` warns about that first. See
[`config/agents/README.md`](../agents/README.md#installing-into-the-harness-homes). The same command links
`<config dir>/AGENTS.md` to the shared [`config/agents/instructions.md`](../agents/instructions.md).

- `share: "disabled"` and `update: "notify"` keep sessions local and leave upgrades to `npm`.
- `permissions` is an ordered rule list where the last matching rule wins. opencode appends these rules after every
  built-in agent's own rules, so they override the built-in "allow everything" default:
  1. `shell` asks for every command by default.
  2. The command allowlist between the `BEGIN GENERATED shell-permissions` / `END GENERATED shell-permissions` markers
     is generated from the `shared` tier of the canonical list,
     [`config/agents/shell-permissions.jsonc`](../agents/shell-permissions.jsonc), by `config/agents/sync.ts generate`
     (see [`config/agents/README.md`](../agents/README.md)); edit the canonical list, not this region. `git status *`
     becomes `{ "action": "shell", "resource": "git status *", "effect": "allow" }`; a pattern ending in space-star also
     matches the bare `git status`. Each entry's `except` globs follow as `ask` rules, so they override the allows.
  3. `read` denies for `*.env`, `*.env.*`, and `*.envrc` come last, mirroring Claude's `Read(./.env*)` denies.
- `model` and `providers` are intentionally absent: they are per-machine, so set them in the live file only.
- MCP servers and npm plugins are out of scope for now and are not part of the baseline. Options for the repo's own
  [plugins](./plugins/README.md#install) go in a `plugins` entry in the live file.

Check what opencode actually loaded with `opencode debug config` (merged sources) and `opencode debug agents` (each
agent's effective permission list).

## `cli-baseline.json`

TUI settings on the v2 CLI schema (`https://opencode.ai/v2/cli.json`): the Solarized theme in dark mode, matching the
Codex and pi themes. `config/agents/sync.ts apply` copies or merges it into `<config dir>/cli.json` the same way.

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
