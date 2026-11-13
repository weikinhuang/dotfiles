# Agent harness shared config

Configuration shared by every agent harness this repo configures (Claude Code, Codex CLI, GitHub Copilot CLI, opencode,
and pi). The per-harness directories ([`claude/`](../claude/README.md), [`codex/`](../codex/README.md),
[`copilot/`](../copilot/README.md), [`opencode/`](../opencode/README.md), [`pi/`](../pi/README.md)) hold each product's
own baselines; this directory holds the sources they are generated from.

## Files

- [`instructions.md`](./instructions.md) - shared core instructions, linked into every harness under the name it loads
  (see [Installing into the harness homes](#installing-into-the-harness-homes)).
- [`env`](./env) - shared environment (turns `core.fsmonitor` off for agent-run git), sourced by the
  `plugins/30-{claude,codex,copilot,opencode,pi}.sh` wrappers right before each harness's own `<profile dir>/env`, so a
  profile can still override it.
- [`shell-permissions.jsonc`](./shell-permissions.jsonc) - canonical shell-command allowlist.
- [`sync.ts`](./sync.ts) - CLI: `generate` emits each harness's permission format from the list; `diff` / `apply`
  install the repo config into the harness homes. [`toml-codec.ts`](./toml-codec.ts) is its TOML reader / writer.
- [`skills/`](./skills/) - shared agent skills.

## Shell allowlist

[`shell-permissions.jsonc`](./shell-permissions.jsonc) is an `entries` array; each entry is one allowed command glob:

```jsonc
{
  "entries": [
    { "pattern": "git status *", "tier": "shared", "copilot": "readonly" },
    { "pattern": "cp *", "tier": "extras" },
    { "pattern": "yq *", "tier": "shared", "except": ["yq -i *", "yq * -i *"], "note": "`-i` edits files." },
  ],
}
```

| Field     | Required | Meaning                                                                                                   |
| --------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `pattern` | yes      | Claude / opencode glob. A pattern ending in space-star (`git status *`) also matches the bare command.    |
| `tier`    | yes      | `shared`: every harness, and pi must allow it too. `extras`: Claude and Codex only (writes, checkouts).   |
| `except`  | no       | Globs that must still ask even though `pattern` allows them.                                              |
| `note`    | no       | Risk note, emitted as a comment next to the rule in every format that has comments.                       |
| `copilot` | no       | Why the entry is not emitted for Copilot: `readonly` (built-in read-only tier) or `broader` (identifier). |
| `codex`   | no       | `broader`: a Codex prefix rule would match more than `pattern` (exact patterns such as `git remote`).     |

The validator rejects unknown keys, duplicate patterns, and patterns with leading, trailing, or doubled whitespace.

### What each harness gets

| Harness  | Output                                                                                                  | Tiers  | `except`                                                                      | `note`                                              |
| -------- | ------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| Claude   | `permissions.allow` / `permissions.ask` in [`settings-baseline.json`](../claude/settings-baseline.json) | both   | `Bash(<glob>)` ask rules                                                      | bullet in [`claude/README.md`](../claude/README.md) |
| opencode | generated region of the `permissions` array in [`opencode.jsonc`](../opencode/opencode.jsonc)           | shared | `ask` rules after the allows (last match wins), before the `.env` read denies | `//` comment                                        |
| Copilot  | generated region of [`tool-permissions`](../copilot/tool-permissions)                                   | shared | entry skipped                                                                 | `#` comment                                         |
| Codex    | [`codex/dotfiles.rules`](../codex/dotfiles.rules) (whole file)                                          | both   | entry skipped                                                                 | `#` comment                                         |
| pi       | not generated; [`bash-permissions-example.json`](../pi/bash-permissions-example.json) is hand-written   | -      | -                                                                             | -                                                   |

- Copilot matches a command identifier (the command name plus a first-level subcommand for tools such as `git`, `gh`,
  `npm`), so `git status *` becomes `allow shell(git status:*)` and `npm -v` becomes `allow shell(npm -v)`. Entries
  marked `copilot`, and globs with any wildcard other than a trailing space-star, are skipped and keep asking. See
  [`copilot/README.md`](../copilot/README.md#how-copilot-matches-shell-rules).
- Codex prefix rules match the leading argv tokens, so the trailing `*` is dropped (`git status *` becomes
  `prefix_rule(pattern=["git", "status"], decision="allow")`). Globs with any other wildcard are skipped.
- pi keeps hand-written regexes (negative lookaheads for `find -exec`, `sed -i`, `yq -i`, `kubectl get secret`, ...).
  [`tests/config/agents/shell-permissions.spec.ts`](../../tests/config/agents/shell-permissions.spec.ts) checks that pi
  allows a sample command for every `shared` entry and rejects a sample for every `except` glob. pi's file is read-only
  by design, so `extras` entries are not added to it.

## Regenerating

Edit [`shell-permissions.jsonc`](./shell-permissions.jsonc), then run:

```bash
config/agents/sync.ts generate          # rewrite the generated files
config/agents/sync.ts generate --check  # exit 1 and list stale files; writes nothing
```

`generate` only rewrites what it owns: Claude's `permissions.allow` / `permissions.ask` (every other key is kept), the
`BEGIN GENERATED shell-permissions` / `END GENERATED shell-permissions` regions in `opencode.jsonc`, `tool-permissions`,
and `claude/README.md`, and the whole `codex/dotfiles.rules`. Hand-written headers and the `.env` denies stay as they
are. A spec fails when the committed files differ from the generator output.

Run `config/agents/sync.ts apply` afterwards to install the regenerated files (see below). The pure helpers live in
[`lib/node/agents-config/`](../../lib/node/agents-config/), with specs under
[`tests/lib/node/agents-config/`](../../tests/lib/node/agents-config/).

## Installing into the harness homes

```bash
config/agents/sync.ts                          # same as `diff`: print every change, exit 1 when out of sync
config/agents/sync.ts diff --harness codex     # one harness (repeatable, or comma-separated)
config/agents/sync.ts apply                    # make the changes diff printed
config/agents/sync.ts apply --force            # also replace symlinks that point somewhere else
```

`diff` writes nothing. `apply` runs the same plan, so it does exactly what `diff` printed, and it is idempotent: a
second `apply` and a following `diff` report `nothing to do`. Harness names are `claude`, `codex`, `copilot`,
`opencode`, `pi`, and `skills`; all of them run by default.

Each harness home comes from the same env var the `plugins/30-*.sh` wrappers set for `-u <profile>`, so
`CODEX_HOME=~/.config/codex-work config/agents/sync.ts apply --harness codex` installs into a named profile. A harness
whose home does not exist is skipped with a note.

| Harness  | Home (default)                                                   | Links                                                                                                                                                                                                                              | Settings merged from the baseline                                                                                                                        |
| -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `CLAUDE_CONFIG_DIR` (`~/.claude`)                                | `CLAUDE.md` -> [`claude/global-claude.md`](../claude/global-claude.md)                                                                                                                                                             | `settings.json` <- [`claude/settings-baseline.json`](../claude/settings-baseline.json)                                                                   |
| Codex    | `CODEX_HOME` (`~/.codex`)                                        | `AGENTS.md` -> [`instructions.md`](./instructions.md); `rules/dotfiles.rules` is a copy of [`codex/dotfiles.rules`](../codex/dotfiles.rules)                                                                                       | `config.toml` <- [`codex/config.toml`](../codex/config.toml)                                                                                             |
| Copilot  | `COPILOT_HOME` (`~/.copilot`)                                    | `copilot-instructions.md` -> [`instructions.md`](./instructions.md); `tool-permissions` -> [`copilot/tool-permissions`](../copilot/tool-permissions)                                                                               | `settings.json` <- [`copilot/settings-baseline.json`](../copilot/settings-baseline.json) (`config.json` is never touched)                                |
| opencode | `OPENCODE_CONFIG_DIR` (`${XDG_CONFIG_HOME:-~/.config}/opencode`) | `AGENTS.md` -> [`instructions.md`](./instructions.md)                                                                                                                                                                              | `opencode.jsonc` <- [`opencode/opencode.jsonc`](../opencode/opencode.jsonc); `cli.json` <- [`opencode/cli-baseline.json`](../opencode/cli-baseline.json) |
| pi       | `PI_CODING_AGENT_DIR` (`~/.pi/agent`)                            | `AGENTS.md` -> [`instructions.md`](./instructions.md); `APPEND_SYSTEM.md` -> [`pi/append-system.md`](../pi/append-system.md); `bash-permissions.json` -> [`pi/bash-permissions-example.json`](../pi/bash-permissions-example.json) | `settings.json` <- [`pi/settings-baseline.json`](../pi/settings-baseline.json)                                                                           |
| skills   | `~/.agents/skills` (a real directory)                            | one link per directory in [`skills/`](./skills/)                                                                                                                                                                                   | -                                                                                                                                                        |

Codex loads every regular `*.rules` file in `rules/` but skips symlinks (checked with `codex debug prompt-input` on
0.156.1), so `dotfiles.rules` is copied; `diff` reports a stale copy after `generate` changes it.

### Links

New links point at this checkout's real path. An existing link that resolves to the same file (for example through
`~/.dotfiles`) counts as in sync. Edits made through a link land in the repo and show up in `git diff`, which is
intended.

- A real file in the way is moved to `<name>.dotfiles-backup-<YYYYmmddHHMMSS>` first; `diff` says so.
- A symlink that resolves somewhere else is a conflict (exit 1) unless `--force` is given. A broken symlink is replaced.
- A real directory in the way is a conflict and is never touched.
- Missing parent directories (such as `rules/`) are created.
- `~/.agents/skills` stays a real directory, so `copilot skill add` and similar installs do not write into the repo.
  `apply` adds the missing skill links and removes broken links; real directories, files, and links that resolve
  somewhere else are left alone. A whole-directory link there is a conflict.

### Settings merge

- Keys in the baseline are owned by the repo and overwrite the live value; objects merge key by key; arrays are replaced
  whole (`diff` lists the removed and added entries). Every other live key (runtime state, app-managed tables,
  per-machine `model`) is kept, in its original order; new keys are appended.
- The live file is copied to `<name>.dotfiles-backup-<YYYYmmddHHMMSS>` before it is rewritten, and its permission bits
  are kept. Nothing is written when the merge changes nothing.
- A missing live file gets the baseline verbatim, comments included.
- A merged file is re-serialized: JSON with 2-space indent, TOML through `smol-toml`. Comments in a live
  `opencode.jsonc` or `config.toml` are lost (`diff` warns when the live file has any); Codex already strips them when
  it saves.
- A live settings file that is a symlink, or that does not parse, is a conflict and is left alone.
- Values of keys matching `token`, `secret`, `password`, `key`, or `auth` (case-insensitive, at any depth, including
  `env` blocks) print as `<redacted>`.

### Shared env

The `fsmonitor` lines in [`env`](./env) used to be duplicated in each harness's machine-local `env` file. `diff` prints
a `hint:` (not an action; it does not change the exit code) for every harness `env` that still has them. Remove those
lines by hand; sync never edits the `env` files because they hold secrets.
