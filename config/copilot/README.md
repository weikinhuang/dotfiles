# GitHub Copilot CLI config

Configuration and custom tooling for the [GitHub Copilot CLI](https://github.com/github/copilot-cli) (`copilot`).
Verified against copilot 1.0.103.

## Files

- [`settings-baseline.json`](#settings-baselinejson) - mirrors `~/.copilot/settings.json`.
- [`tool-permissions`](#tool-permissions) - shell / file permission rules the wrapper passes as `--allow-tool` /
  `--deny-tool` flags.
- [`session-usage.ts`](#session-usagets) - CLI that reads `~/.copilot/session-state/*/events.jsonl` and summarizes
  session token / tool usage.

The shell wrapper and completion live in [`plugins/30-copilot.sh`](../../plugins/30-copilot.sh).

## `settings-baseline.json`

Reference user settings. Copy or merge them into `~/.copilot/settings.json` by hand, the same way the Claude Code,
Codex, and opencode baselines are installed; for a named profile the target is `<profile dir>/settings.json` (see
[Profiles](#profiles)). `copilot config --list` shows the effective values, and `/settings` lists unknown keys under
**Problems**.

- `includeCoAuthoredBy: false` drops the `Co-authored-by` commit trailer, like Claude's empty `attribution`.
- `effortLevel: "high"` and `memory: true` match the Claude baseline's effort level and auto memory.
- `terminalProgress: false`, `banner: "never"`, and `showTipsOnStartup: false` keep the TUI quiet.
- `theme: "default"` follows the terminal palette; copilot has no Solarized or `auto` theme.
- `model` is intentionally absent: it is per machine, so set it in the live file (or `/model`).
- `autoUpdate` stays at its default (`true`). Updates land in the cache dir (`~/Library/Caches/copilot/pkg/` on macOS,
  `${XDG_CACHE_HOME:-~/.cache}/copilot/pkg/` on Linux), not in the npm install, so the running version can be newer than
  `npm ls -g @github/copilot`. Do not set `COPILOT_AUTO_UPDATE=false`: it also ignores already-downloaded versions and
  falls back to the version bundled with the npm package.
- `remoteExport` stays at its default for now (sessions sync to GitHub, which also feeds `/resume` cloud history).
- MCP servers, plugins, custom agents, hooks, and the status line are out of scope for now.

Client telemetry has no settings key; the wrapper passes `--disable-client-telemetry` on every invocation instead.

## `tool-permissions`

Copilot reads allow / deny rules only from the command line (`--allow-tool`, `--deny-tool`) or from enterprise-managed
settings; `permissions.allow` / `deny` in `settings.json` are managed-only, and `permissions-config.json` only stores
per-repository "don't ask again" approvals. So the [`copilot` wrapper](../../plugins/30-copilot.sh) reads
`<COPILOT_HOME>/tool-permissions` and turns each line into a flag:

```text
# comment
allow shell(jq:*)       -> --allow-tool=shell(jq:*)
deny read(.env)         -> --deny-tool=read(.env)
```

Blank lines and `#` comments are ignored. Any other verb, or a verb without a pattern, is an error and copilot does not
start, so a typo cannot silently drop a deny rule. A missing file adds no flags. Copy this file to `~/.copilot/` (and to
each profile dir) by hand.

### How copilot matches shell rules

Copilot parses each shell command (every segment of a compound command separately) into a **command identifier**: the
command name, plus a first-level subcommand for tools it knows (`git stash list --oneline` -> `git stash`,
`gh config get editor` -> `gh config`, `npm config get registry` -> `npm config`, `docker ps -a` -> `docker`). Rules
match the identifier, never the arguments:

- `shell(X)` matches identifier `X` with any arguments.
- `shell(X:*)` matches `X` or `X <more>`, including the bare command (`mkdir:*` matches `mkdir`); it does not match
  `Xfoo`.
- A rule finer than the identifier never matches (`shell(npm config get:*)`, `shell(docker ps)`).
- A compound command runs only if every segment is allowed; output redirection (`echo x > f`) still asks as a write.

The identifier for any command shows up in `~/.copilot/session-state/<id>/events.jsonl` as
`permission.requested.data.permissionRequest.commands[].identifier`.

Deny rules always win, including over `--allow-all` / `--yolo` and saved approvals.

### Port from the Claude allowlist

The rules mirror `permissions.allow` in [`config/claude/settings-baseline.json`](../claude/settings-baseline.json). Each
Claude rule was run once against copilot 1.0.103 with no flags and sorted into:

- **Already auto-approved** (72 rules, left out): copilot's built-in read-only tier runs them without asking, e.g.
  `cat`, `grep`, `rg`, `ls`, `find`, `sed`, `head`, `tail`, `git status` / `log` / `diff` / `show`, and `gh pr view` /
  `gh issue list` / `gh run view`. The tier judges each invocation, so `find -delete` or `sed -i` still ask, which is
  stricter than Claude.
- **Ported** (63 rules): the identifier equals the Claude rule's command words, so `Bash(jq *)` becomes `shell(jq:*)`
  and `Bash(npm --version)` becomes `shell(npm --version)`.
- **Dropped because copilot's rule would be broader** (48 rules, these keep asking): all `docker ...` rules (identifier
  `docker`), all `glab ...` rules (identifiers such as `glab mr` would also allow `glab mr merge`), `gh config`,
  `gh label`, `gh ruleset`, `gh run watch`, `gh secret`, `gh variable`, `git stash list` / `show`,
  `git submodule status`, `git worktree list`, `npm config get` / `list`, `node --version` / `-v` (identifier `node`),
  `command -v`, `env`, `alias`, `rev`, and `select`.

Keep this file and the Claude list in sync when adding entries; check new identifiers the same way.

The three `read(...)` denies mirror Claude's `Read(./.env*)` denies. They block copilot's file tools for `.env`,
`.env.*` (including `.env.example`), and `.envrc`. Shell reads such as `cat .env` go through the read-only tier and are
not covered, the same gap Claude has with `Bash(cat *)`.

## Profiles

`copilot -u <name> ...` runs copilot against `${XDG_CONFIG_HOME:-$HOME/.config}/copilot-<name>/`, created on first use,
like the `claude`, `codex`, `opencode`, and `pi` wrappers:

- `COPILOT_HOME` points at the profile dir: settings, `config.json` (which account is logged in), saved approvals,
  `copilot-instructions.md`, skills, sessions, and logs.
- `COPILOT_PROFILE_NAME` is exported, and `<profile dir>/env` is sourced if present.
- `COPILOT_SKILLS_DIRS` gets `~/.agents/skills` prepended: copilot only discovers `~/.agents/skills` when `COPILOT_HOME`
  is `~/.copilot`.
- `<profile dir>/tool-permissions` supplies the permission flags.

Without `-u`, the wrapper uses `${COPILOT_HOME:-~/.copilot}` for `env` and `tool-permissions` and changes nothing else.

What a profile does **not** isolate:

- **The login token.** `/login` stores it in the macOS Keychain under service `copilot-cli`, keyed by
  `https://github.com:<login>`. A new profile starts logged out, but two profiles logged in as the same GitHub user
  share one token. Different users stay separate.
- **Env tokens.** `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` (and a `gh` CLI login) apply to every profile;
  set them in a profile's `env` file only if that is intended.
- **The cache dir** (auto-update packages, marketplace and MCP tool caches), which copilot keys by account. Override it
  per profile with `COPILOT_CACHE_HOME` in the profile's `env` if needed.

There is no shared background server. The GitHub Copilot desktop app and the VS Code Copilot extension also use
`~/.copilot`, so named profiles do not see their sessions or auto-connect to VS Code.

## `session-usage.ts`

CLI that reads the per-session event logs in `<user dir>/session-state/*/events.jsonl` and prints session summaries. It
needs copilot versions that write `session.usage_record` events (1.0.103 does; 1.0.89 and 1.0.92 did not). `list` and
`totals` skip older sessions with a one-line notice, and `session <id>` on one fails with an "unsupported older event
format" error. `session-store.db` is not read: it is a rebuildable index that never records tool calls.

### Usage

```sh
# List every Copilot session rooted under $PWD.
./session-usage.ts list

# Filter to sessions under a specific directory tree.
./session-usage.ts list --project ~/src/someproject

# Detailed single-session report (prefix match on the id is enough).
./session-usage.ts session 469bbb1b

# Sessions from a named profile.
./session-usage.ts list --user-dir ~/.config/copilot-work
```

### Options

- **`--project, -p <path>`** - filter sessions by directory tree. Defaults to `$PWD`.
- **`--user-dir, -u <dir>`** - copilot home holding `session-state/`. Defaults to `$COPILOT_HOME` when set, else
  `~/.copilot`.
- **`--sort <field>`** - `date` (default), `tokens`, `duration`, or `tools`.
- **`--limit, -n <N>`** - cap output to the top N sessions.
- **`--json`** - machine-readable JSON output.
- **`--no-color`** - disable ANSI colors.

### Columns and fields

Turns count `user.message` events. Tokens and models come from root-agent `session.usage_record` events; copilot's
`inputTokens` includes the cached slices, so `INPUT` is the total prompt size and `CACHED` the part read from cache. The
`CONTEXT` column is the last root call's `inputTokens`. Tool counts come from `tool.execution_start`. Subagent calls
(`parentToolCallId`) are grouped per subagent and labelled from `subagent.started`. The title comes from
`workspace.yaml` `name:`. Copilot bills in premium requests, not USD, so no cost is shown.

`ai-cost-doctor copilot <id>` reads the same events.
