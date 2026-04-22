# Claude Code config

Tracked source for what lives under `~/.claude/` plus the dotfiles [statusline-command.sh](./statusline-command.sh). See root [AGENTS.md](../../AGENTS.md) for project-wide conventions.

## Boundaries

**Always**: keep [README.md](./README.md) in sync with any change to this directory. Specifically —

- When **adding, renaming, or removing** a file, update both the `Files` list and the per-file section.
- When changing **statusline output** (new segment, new/removed color, different separator, new env var), update the `Example`, `Line 1`, and `Line 2` breakdowns in the `statusline-command.sh` section.
- When changing **CLI flags or commands** on `session-usage.ts`, update its `Usage` / `Options`.
- When changing **keys, env vars, or linked paths** in `settings-local.json`, update its section.

After editing `statusline-command.sh`, run `./dev/lint.sh` and re-run the bats coverage:

```sh
./dev/test-docker.sh tests/config/claude/statusline-command.bats
```

**Ask first**: anything that changes where files are expected to be installed under `~/.claude/`, or that depends on Claude Code features not yet available in stable releases.
