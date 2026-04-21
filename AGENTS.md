# Dotfiles

Cross-platform bash dotfiles for Linux, macOS, and WSL. Shell scripts, git utilities, plugins, and prompt customization.

## Commands

- `./dev/lint.sh` -- shellcheck + shfmt on all tracked shell scripts
- `./dev/test-docker.sh` -- run full bats test suite in Docker (recommended)
- `./dev/test-docker.sh -q` -- quiet mode, prints only failures and a summary
- `./dev/test-docker.sh tests/dotenv/bin/git-sync.bats` -- run a single test file
- `./dev/test.sh` -- run tests locally (requires apt-installed bats, bats-support, bats-assert)

## Directory map

| Path | Purpose |
| --- | --- |
| `dotenv/` | Core shell environment: aliases, functions, exports, completions, prompt |
| `dotenv/bin/` | Git subcommands and CLI utilities added to `$PATH` |
| `dotenv/{linux,darwin,wsl,wsl2,ssh,tmux,screen}/` | Platform-specific overrides, loaded conditionally |
| `dotenv/lib/` | Internal loader and utility libraries |
| `plugins/` | Numbered shell plugins loaded near end of init (e.g. `10-fzf.sh`) |
| `external/` | Vendored third-party scripts -- do not edit |
| `tests/` | Bats test files mirroring `dotenv/` structure ([tests/AGENTS.md](./tests/AGENTS.md)) |
| `tests/helpers/common.bash` | Shared test setup: mock stubs, git helpers, isolated HOME |
| `config/` | Non-shell config files (git, vim, tmux, ripgrep, bat, eza, claude) |
| `utils/` | Platform setup guides and native wrappers (WSL, macOS, Termux) |
| `dev/` | Developer tooling: lint, test runners, Dockerfile |
| `bootstrap.sh` | Installer that symlinks dotfiles into `$HOME` |

## Key patterns

### Dotenv layout

Each directory under `dotenv/` (including platform dirs) can define phase files loaded in this order: `exports`, `functions`, `aliases`, `extra`, `env`, `completion`, `prompt`. Plugins are loaded as a separate phase from [`plugins/`](./plugins) and `~/.bash_local.d/*.plugin` after `completion` and before `prompt`. Only create the files you need. Platform environments load in this order: common `dotenv/` → `{darwin,linux}/` → `wsl/` → `wsl2/` → `tmux/` → `screen/` → `ssh/`.

### Plugins

Plugins live in `plugins/` with numeric prefixes controlling load order (e.g. `00-`, `10-`, `30-`). Guard with `command -v` checks so they no-op when the tool is absent. Users disable individual plugins via `DOT_PLUGIN_DISABLE_<basename>=1`, with leading numeric prefixes stripped.

### Bin scripts

Scripts in `dotenv/bin/` and platform `bin/` dirs are added to `$PATH`. Git subcommands use the naming convention `git-<name>` and are invoked as `git <name>`. Private internal scripts not intended for direct user invocation use a `__` prefix (e.g. `__sshd-auto-start`). Include `#!/usr/bin/env bash` and `set -euo pipefail`.

For helper functions inside standalone `bin/` scripts, prefer plain helper names by default. Reserve script-specific prefixes only when they materially improve clarity or avoid collisions during test sourcing.

Argument parsing patterns — use `genpasswd` as the reference implementation:

- **Help-only** (no other flags): use a leading `case "${1:-}" in -h | --help) ... esac`
- **Multiple options**: use a `while [[ $# -gt 0 ]]; do case "$1" in` loop with `shift`; support both `--flag value` and `--flag=value` forms; print an error and exit 1 on unknown args; always `exit 0` after `print_help`

Every new bin script ships with a matching bash completion file under the sibling `completion/` directory: `dotenv/bin/foo` → `dotenv/completion/foo.bash`, `dotenv/wsl/bin/foo` → `dotenv/wsl/completion/foo.bash`, etc. Use a small `_dot_<name>()` function with `complete -F` for scripts that have positional args, flag values, or subcommand verbs; use the `complete -W "..."` shortcut for flag-only or trivial wrappers (add `-o default` if file completion should still kick in for non-flag words). Private `__`-prefixed scripts don't need completions.

### Tests

Tests mirror source paths: `dotenv/bin/git-sync` → `tests/dotenv/bin/git-sync.bats`. Prefix `@test` names with the script name and colon (e.g. `@test "git-sync: restores dirty state"`). Use `source_without_main` to unit-test internal functions. See [TESTING.md](./TESTING.md) for the full helper API and examples.

### Cache files

Route cache file writes through `internal::cache-write-atomic` in `dotenv/lib/utils.sh` so parent-directory creation, atomic replacement, and readonly-cache failures are handled in one place. Cache reads can stay inline when they are simple `[[ -f/-s ]]` checks plus `source`/`read`; add a shared read helper only if read-side policy becomes meaningfully more complex.

### Hooks

The dotfiles provide `chpwd`, `precmd`, and `preexec` hooks with Zsh-like semantics. Hooks for each dotenv loading phase are available via `dotfiles_hook_${PHASE}_{pre,post}` functions or the `dotfiles_hook_${PHASE}_{pre,post}_functions` arrays. Declare hooks in `~/.bash_local` or `~/.bash_local.d/*.sh`.

### Shell style

shfmt flags: `-ln bash -ci -bn -i 2` for shell files, `-ln bats -ci -bn -i 2` for `.bats` files. shellcheck runs with `--source-path=SCRIPTDIR`, and `.bats` files are checked with `shellcheck -s bats -S warning`. Add shellcheck directives for valid exceptions only.

For sourced shell code, use `__dot_*` for internal variables and `internal::...` for internal functions. Scoped variable families like `__dot_ps1_*` and `__dot_ssh_*` are preferred over one-off prefixes.

### Customization model

Users customize via `~/.bash_local` and `~/.bash_local.d/*.sh`, both sourced before the repo built-ins. Plugins also load from `~/.bash_local.d/*.plugin` during the plugin phase. The entry points are `bash_profile.sh` → `bashrc.sh` → `dotenv/lib/load.sh`. Configuration is controlled by `DOT_*` environment variables documented in [README.md](./README.md#configuration-options), while [REFERENCE.md](./REFERENCE.md) is the detailed source of truth for loader behavior.

## Boundaries

**Always**: run `./dev/lint.sh` after changing shell scripts; run `./dev/test-docker.sh` after modifying or adding tests; place new tests mirroring their source path under `tests/`; update [REFERENCE.md](./REFERENCE.md) when changing the public shell surface, including aliases, functions, env vars, git subcommands, hooks, prompt options, plugin-exposed behavior, or commands on `$PATH`.

**Ask first**: adding new plugins; modifying `bootstrap.sh` or `dotenv/lib/load.sh`; adding external dependencies; changing the dotenv loading order.

**Never**: edit files in `external/` (vendored third-party); commit secrets or credentials; remove or rename existing dotenv layout files without updating `dotenv/lib/load.sh`.

## References

- [TESTING.md](./TESTING.md) -- test framework, helpers, mock behavior, writing conventions
- [REFERENCE.md](./REFERENCE.md) -- all aliases, functions, env vars, and git utilities
- [PROMPT.md](./PROMPT.md) -- prompt format, symbols, and customization options
- [README.md](./README.md) -- installation, configuration, hooks, file loading order
- [utils/darwin/README.md](./utils/darwin/README.md) -- macOS setup and native wrappers
- [utils/wsl/README.md](./utils/wsl/README.md) -- WSL setup and native wrappers
