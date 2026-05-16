# Config

Non-shell configuration files consumed by third-party tools. Most subdirectories hold static config (`bat`, `ripgrep`,
`eza`, `tmux`, `vim`, `git`) that the matching plugin points a tool at; the four code-bearing subdirectories (`claude/`,
`codex/`, `opencode/`, `pi/`) additionally carry their own TypeScript / shell tooling. See root
[AGENTS.md](../AGENTS.md) for repo-wide conventions; this file only documents what is different here.

## Commands

- `./dev/lint.sh` - shellcheck + shfmt (touches `statusline-command.sh` and other shell under this tree).
- `./dev/test-docker.sh tests/config/` - run bats coverage for any config shell script that has tests.
- `npx vitest run tests/config/` - run vitest coverage for `session-usage.ts` specs under this tree.

## Directory map

See [README.md](./README.md) for the full per-directory table; high-level grouping:

| Path                                                                                                                 | Purpose                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [`bat/`](./bat/), [`eza/`](./eza/), [`git/`](./git/), [`ripgrep/`](./ripgrep/), [`tmux/`](./tmux/), [`vim/`](./vim/) | Static config pointed at by the matching [`../plugins/`](../plugins/) shell plugin or installed by [`../bootstrap.sh`](../bootstrap.sh). |
| [`claude/`](./claude/)                                                                                               | Claude Code config + custom statusline + session-usage CLI ([AGENTS.md](./claude/AGENTS.md)).                                            |
| [`codex/`](./codex/)                                                                                                 | Codex CLI config + session-usage CLI.                                                                                                    |
| [`opencode/`](./opencode/)                                                                                           | opencode config + session-usage CLI.                                                                                                     |
| [`pi/`](./pi/README.md)                                                                                              | pi config: extensions, skills, subagent defs, themes, session-usage CLI.                                                                 |

## Key patterns

### Static-config subdirs

- Mount point is a shell plugin in [`../plugins/`](../plugins/), typically via an env var like `RIPGREP_CONFIG_PATH` or
  `BAT_CONFIG_PATH`. When changing **what the tool reads**, update both the config file here and the plugin in lockstep.
- When **adding a new tool**, add both the config subdirectory AND a corresponding row to the
  [REFERENCE.md "Tool defaults" table](../REFERENCE.md) - that table is the canonical list.
- Keep filenames exactly as the tool expects (`bat/config`, `ripgrep/config`, `eza/solarized-dark.yml`). Renaming breaks
  the plugin.

### Code-bearing subdirs (`claude/`, `codex/`, `opencode/`, `pi/`)

- `session-usage.ts` is a shared harness: all four adapters render and parse args via
  [`../lib/node/ai-tooling/`](../lib/node/ai-tooling). When adding a new flag or column, update all four in lockstep so
  the UX stays identical across providers. Specs live under [`../tests/config/*/`](../tests/config).
- `settings-baseline.json` (or `config.toml`, `opencode.jsonc`) **mirrors** the live product file under `~/.<tool>/`.
  Keep runtime-only keys (e.g. `lastChangelogVersion`) out of the baseline.
- Each subdir has its own [AGENTS.md](./claude/AGENTS.md) / [README.md](./pi/README.md) covering product-specific rules;
  update those when the product surface changes, not this file.

## Boundaries

**Always**: update [REFERENCE.md](../REFERENCE.md)'s "Tool defaults" table when adding, renaming, or retargeting a
config subdirectory; keep [README.md](./README.md) in sync with directory additions / removals; run `./dev/lint.sh`
after touching shell files under this tree.

**Ask first**: adding a new tool integration (new subdirectory + plugin pair); changing a [`../plugins/`](../plugins/) →
`config/*/` binding (which file a plugin points the tool at).

**Never**: commit per-user tokens, API keys, or workspace-specific secrets into any `settings-*.json` / `config.toml` /
`*.jsonc` baseline. Use env vars and reference an example file instead.

## References

- [README.md](./README.md) - per-directory index and consumer table.
- [../REFERENCE.md](../REFERENCE.md) - "Tool defaults" table: canonical list of every config subdir + its plugin.
- [claude/AGENTS.md](./claude/AGENTS.md), [pi/README.md](./pi/README.md) - product-specific rules for the two
  code-bearing subdirs with their own agent docs.
