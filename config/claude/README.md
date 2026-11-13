# Claude Code config

Configuration, personal instructions, and custom tooling for [Claude Code](https://code.claude.com).

## Files

- [`statusline-command.sh`](#statusline-commandsh) - two-line status line rendered at the bottom of every Claude Code
  session.
- [`session-usage.ts`](#session-usagets) - CLI that walks `~/.claude/projects/` and summarizes transcript token/tool
  usage.
- [`settings-baseline.json`](#settings-baselinejson) - mirrors `~/.claude/settings.json`.
- [`settings-local.json`](#settings-localjson) - mirrors `~/.claude/settings.json`.
- [`global-claude.md`](./global-claude.md) - global instructions, linked as `~/.claude/CLAUDE.md` by
  `config/agents/sync.ts apply`. It `@`-imports the shared core
  ([`config/agents/instructions.md`](../agents/instructions.md)); Claude-only rules go below the import.
- [`CLAUDE-local.md`](./CLAUDE-local.md) - personal, workspace-level instructions for the local-LLM profile (tool
  preferences, response style). Not part of the shared layer and not installed by sync; link it as that profile's
  `CLAUDE.md` by hand.

## `statusline-command.sh`

Two-line status line in the dotfiles PS1 style. Claude Code invokes it after every turn and on a 5 s refresh tick
([`settings-baseline.json`](./settings-baseline.json)), passing the session state as JSON on stdin.

### Example

```text
[user#host,work .dotfiles (main *$%>) ⎇ feature/foo 72% left $0.142 5h:42%·2h 7d:18%·2d §a0cd2e69] Opus 4.7
 ↳ M(12):↑2k/↻ 14k/↓340 | A(2):↑45k/↻ 120k/↓3k | S:↑120k/↻ 1.2M/↓8k | ⚒ A:12(~4k) S:47(~18k)
```

### Line 1 - shell-style context

- **`user#host,<profile>`** - same user/host the shell prompt shows. will show the named claude code profile when
  `CLAUDE_CODE_PROFILE_NAME` is set.
- **`cwd`** - basename of `workspace.current_dir`.
- **`(git …)`** - rendered through [`external/git-prompt.sh`](../../external/git-prompt.sh).
- **`⎇ <name>`** - linked worktree indicator. Only shown when `workspace.git_worktree` is set.
- **`N% left`** - context-window remaining.
- **`$N.NNN`** - session cost in USD.
- **`5h:N%·<time>` and `7d:N%·<time>`** - Pro/Max rate-limit windows: percent used and countdown to reset.
- **`§xxxxxxxx`** - first 8 chars of the session UUID. Use as a prefix for `session-usage.ts session <id>`.
- **`<model>`** - model display name.

### Line 2 - token and tool totals

- **`M:↑in/↻ cached/↓out`** - most recent API call. `↑` input + cache-creation, `↻` cache-read, `↓` output. Becomes
  `M(N):…` when the turn is available.
- **`A(N):↑in/↻ cached/↓out`** - cumulative subagent totals.
- **`S:↑in/↻ cached/↓out`** - cumulative main-session totals.
- **`⚒ A:N(~tokens) S:N(~tokens)`** - tool call counts; paren values are estimated tool-result tokens (bytes/4).

### Environment variables

- **`CLAUDE_CODE_PROFILE_NAME`** - when set, appended to the host segment (`,profile`) in the tmux/screen PS1 style. The
  [`claude` wrapper](../../plugins/30-claude.sh) sets this automatically when invoked with `-u <profile>`.
- **`DOT_DISABLE_HYPERLINKS`** - disables OSC 8 hyperlinks for the cwd and cost segments.

### Caching

Per-session derived metrics are cached at `${transcript_path%.jsonl}/statusline.cache`, keyed by the transcript's mtime.
Re-renders with no transcript change are cache hits.

## `session-usage.ts`

CLI that scans `~/.claude/projects/` for session transcripts and prints summaries.

### Usage

```sh
# List every session in the project derived from $PWD.
./session-usage.ts list

# Detailed single-session report (prefix match on the UUID is enough).
./session-usage.ts session a0cd2e69

# Target a specific project slug or absolute path.
./session-usage.ts list --project ~/src/someproject
```

### Options

- **`--project, -p <slug|path>`** - project to inspect. Accepts a slug (directory name under `~/.claude/projects/`) or
  any path, which gets resolved to a slug. Defaults to the project matching `$PWD`.
- **`--user-dir, -u <dir>`** - alternate Claude profile root. Defaults to `~/.claude`.
- **`--sort <field>`** - `date` (default), `tokens`, `duration`, or `tools`.
- **`--limit, -n <N>`** - cap output to the top N sessions.
- **`--json`** - machine-readable JSON output.
- **`--no-color`** - disable ANSI colors.

### Columns and fields

The list / detail views include a `CONTEXT` column (and `Context (last turn)` row in detail) when sessions carry
per-turn usage. The value is the input tokens sent to the model on the most recently completed assistant response
(`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`). It is **not** a prediction of what the next
request will send - the next request will add any post-assistant user text and tool results on top. JSON output exposes
the same value as `last_context_tokens`.

## `settings-baseline.json`

A reference baseline config for Claude Code. `config/agents/sync.ts apply` merges it into `~/.claude/settings.json`
(`CLAUDE_CONFIG_DIR` when set): baseline keys win, every other live key is kept, and `diff` shows the changes first. See
[`config/agents/README.md`](../agents/README.md#installing-into-the-harness-homes).

`permissions.allow` and `permissions.ask` are generated from
[`config/agents/shell-permissions.jsonc`](../agents/shell-permissions.jsonc) by `config/agents/sync.ts generate` (see
[`config/agents/README.md`](../agents/README.md)); edit the canonical list, not this file. Every entry of both tiers
becomes a `Bash(<glob>)` allow rule, and every `except` glob a `Bash(<glob>)` ask rule. The rest of the file, including
the `Read(./.env*)` denies, is hand-written.

JSON has no comments, so the risk notes attached to allowed entries live here:

<!-- BEGIN GENERATED shell-permissions (config/agents/sync.ts generate); do not edit by hand -->

- `find *`: `-exec`, `-execdir`, `-ok`, and `-okdir` run commands, `-delete` removes files, and `-fprint` / `-fprintf` /
  `-fls` write files. Allowed outright for now; pi rejects those flags with a regex.
- `sed *`: `-i` / `--in-place` edits files, and the `w` / `e` script commands write files / run commands. Allowed
  outright for now; pi rejects `-i` / `--in-place` with a regex.
- `yq *`: `-i` / `--inplace` edits files, so those forms ask. Bundled short flags such as `-Pi` are not caught outside
  pi.

<!-- END GENERATED shell-permissions -->

## `settings-local.json`

A local-llm friendly sample configuration for Claude Code.
