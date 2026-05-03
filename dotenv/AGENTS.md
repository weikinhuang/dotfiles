# Dotenv

Core shell environment for the dotfiles — aliases, functions, exports, completions, the prompt, loader internals, and
per-platform overrides. See root [AGENTS.md](../AGENTS.md) for repo-wide conventions; this file only documents what is
different here.

## Commands

- `./dev/lint.sh` — shellcheck + shfmt on everything under this tree.
- `./dev/test-docker.sh tests/dotenv/bin/<script>.bats` — run bats coverage for one `bin/` script.
- `./dev/test-docker.sh tests/dotenv/aliases.bats` — run the top-level phase-file tests.
- `./dev/test-docker.sh tests/dotenv/` — full bats suite for this tree.

## Directory map

| Path                                                                                                                                                         | Purpose                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [`aliases.sh`](./aliases.sh), [`functions.sh`](./functions.sh), [`exports.sh`](./exports.sh), [`completion.sh`](./completion.sh), [`prompt.sh`](./prompt.sh) | Top-level phase files loaded by [`lib/load.sh`](./lib/load.sh) on every shell.                    |
| [`bin/`](./bin/), [`completion/`](./completion/)                                                                                                             | Standalone scripts added to `$PATH` and their matching bash completions (one `.bash` per script). |
| [`lib/`](./lib/)                                                                                                                                             | Loader internals and shared helpers sourced by phase files and `bin/` scripts.                    |
| [`darwin/`](./darwin/), [`linux/`](./linux/)                                                                                                                 | Platform-specific phase files + `bin/` + `completion/`; loaded when the host OS matches.          |
| [`wsl/`](./wsl/), [`wsl2/`](./wsl2/)                                                                                                                         | WSL / WSL 2 phase files + `bin/` + `completion/`; loaded on top of `linux/`.                      |
| [`ssh/`](./ssh/), [`tmux/`](./tmux/)                                                                                                                         | Environment-scoped overrides loaded only inside SSH sessions / tmux.                              |

## Key patterns

### Phase files

Each directory (including platform dirs) can define up to seven phase files loaded in order: `exports`, `functions`,
`aliases`, `extra`, `env`, `completion`, `prompt`. Only create the files you need. Platform phases are additive: common
[`aliases.sh`](./aliases.sh) loads first, then `darwin/` or `linux/`, then `wsl/`, `wsl2/`, `tmux/`, `ssh/`.

### `bin/` scripts

Every standalone script is a top-level `set -euo pipefail` bash entrypoint. Git subcommands use `git-<name>` naming so
they're invoked as `git <name>`. Private internal scripts not meant for direct user invocation use a `__` prefix (e.g.
`__sshd-auto-start`).

- Argument parsing: use [`bin/genpasswd`](./bin/genpasswd) as the reference. Help-only scripts use a leading
  `case "${1:-}" in -h|--help) …` check; multi-option scripts use a `while [[ $# -gt 0 ]]; do case "$1" in` loop
  supporting both `--flag value` and `--flag=value`, printing an error and `exit 1` on unknown args.
- Every new `bin/` script ships with a matching `completion/<name>.bash` (private `__`-prefixed scripts excepted). Use
  `_dot_<name>() { … }` + `complete -F` for scripts with positional args or flag values; use `complete -W "…"` for
  flag-only wrappers (add `-o default` for non-flag file completion).

### `lib/` internals

- [`lib/load.sh`](./lib/load.sh) is the loader (`bash_profile.sh` → `bashrc.sh` → `lib/load.sh`); do not add phases
  without updating it.
- Internal names use `__dot_*` for variables and `internal::…` for functions. Prefer scoped families (`__dot_ps1_*`,
  `__dot_ssh_*`) over one-off prefixes.
- Route cache-file writes through `internal::cache-write-atomic` in [`lib/utils.sh`](./lib/utils.sh). Cache reads can
  stay inline when they are simple `[[ -f/-s ]]` + `source` / `read`.

### Customization surface

`~/.bash_local` and `~/.bash_local.d/*.sh` override everything here; `DOT_*` knobs are documented in
[../README.md](../README.md#configuration-options). Changes to those knobs need both `README.md` and
[`../REFERENCE.md`](../REFERENCE.md) updated in lockstep.

## Boundaries

**Always**: ship a matching `completion/<name>.bash` for every new user-facing `bin/` script; update
[`../REFERENCE.md`](../REFERENCE.md) when changing the public shell surface (aliases, functions, env vars, git
subcommands, hooks, prompt options, `$PATH` additions); add or update bats coverage under
[`../tests/dotenv/`](../tests/dotenv/) for behavior changes.

**Ask first**: modifying [`lib/load.sh`](./lib/load.sh) or the phase loading order; renaming or removing an existing
phase file that consumers may be hooking from `~/.bash_local`; adding a new platform subdirectory.

**Never**: break phase-file naming (`aliases.sh` / `functions.sh` / … are hard-coded in `lib/load.sh`); execute commands
at source time that block a non-interactive shell from loading; rely on a tool being installed — always guard
integrations with `command -v`.

## References

- [`../README.md`](../README.md) — installation, phase loading order, customization knobs.
- [`../REFERENCE.md`](../REFERENCE.md) — canonical public shell surface.
- [`../PROMPT.md`](../PROMPT.md) — segment architecture for [`prompt.sh`](./prompt.sh) and [`lib/prompt*.sh`](./lib/).
