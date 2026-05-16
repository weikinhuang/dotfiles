# Claude Code config

Tracked source for what lives under `~/.claude/` plus the dotfiles [statusline-command.sh](./statusline-command.sh). See
root [AGENTS.md](../../AGENTS.md) for repo-wide conventions; this file only documents what is different in this
directory.

## Commands

- `./dev/lint.sh` - shellcheck + shfmt on `statusline-command.sh` (and anything else tracked here).
- `./dev/test-docker.sh tests/config/claude/statusline-command.bats` - bats coverage for the status line.
- `npx vitest run tests/config/claude` - vitest coverage for `session-usage.ts` if you add specs.

## Directory map

| Path                                                 | Purpose                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`statusline-command.sh`](./statusline-command.sh)   | Two-line status line rendered at the bottom of every Claude Code session.                                  |
| [`session-usage.ts`](./session-usage.ts)             | CLI that walks `~/.claude/projects/` and summarizes transcript token / cost / tool usage.                  |
| [`settings-baseline.json`](./settings-baseline.json) | Reference baseline that mirrors `~/.claude/settings.json`.                                                 |
| [`settings-local.json`](./settings-local.json)       | Local-LLM friendly sample configuration.                                                                   |
| [`CLAUDE-local.md`](./CLAUDE-local.md)               | Personal tool-preference instructions Claude Code picks up when symlinked to `~/.claude/CLAUDE.md`.        |
| [`README.md`](./README.md)                           | Human-facing reference for every file in this directory - keep in lockstep with changes (see rules below). |

## Key patterns

Keep [README.md](./README.md) in sync with any change to this directory. Specifically:

- When **adding, renaming, or removing** a file, update both the `Files` list and the per-file section.
- When changing **statusline output** (new segment, new/removed color, different separator, new env var), update the
  `Example`, `Line 1`, and `Line 2` breakdowns in the `statusline-command.sh` section of [README.md](./README.md).
- When changing **CLI flags or commands** on `session-usage.ts`, update its `Usage` / `Options`.
- When changing **keys, env vars, or linked paths** in `settings-local.json`, update its section.

After editing `statusline-command.sh`, run `./dev/lint.sh` and re-run the bats coverage above.

## Boundaries

**Always**: keep [README.md](./README.md) in sync with file additions, renames, removals, and any change that alters the
rendered statusline, `session-usage.ts` CLI surface, or `settings-local.json` key set.

**Ask first**: anything that changes where files are expected to be installed under `~/.claude/`, or that depends on
Claude Code features not yet available in stable releases.

**Never**: commit secrets or per-user tokens into `settings-*.json`; overwrite `~/.claude/settings.json` from these
baseline files without preserving runtime-managed keys (e.g. `lastChangelogVersion`).

## References

- [README.md](./README.md) - per-file deep reference; the authoritative source for statusline format and CLI flags.
- [../../AGENTS.md](../../AGENTS.md) - repo-wide conventions.
- [../pi/README.md](../pi/README.md) - sibling pi config with the same `statusline` / `session-usage` pattern.
