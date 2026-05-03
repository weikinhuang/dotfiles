# Plugins

Numbered bash plugins loaded during the `plugin` phase — after `completion`, before `prompt`. Each plugin integrates one
external tool (`fzf`, `direnv`, `bat`, …) or sets one family of shell options. Only
[`00-bash-opts.sh`](./00-bash-opts.sh) and [`00-chpwd-hook.sh`](./00-chpwd-hook.sh) load by default; the rest need
`DOT_INCLUDE_BUILTIN_PLUGINS=1`. Local `~/.bash_local.d/*.plugin` files interleave by basename. See root
[AGENTS.md](../AGENTS.md) for repo-wide conventions; this file only documents what is different here.

## Commands

- `./dev/lint.sh` — shellcheck + shfmt on every plugin.
- `./dev/test-docker.sh tests/plugins/<name>.bats` — run bats coverage for one plugin when it exists.
- `DOT_INCLUDE_BUILTIN_PLUGINS=1 env -i PATH="$PATH" HOME="$HOME" bash -l` — smoke-test a plugin interactively in a
  fresh shell.
- `DOT_PLUGIN_DISABLE_<name>=1 env -i … bash -l` — confirm a plugin is correctly guarded when its tool is absent.

## Directory map

| Path                                                                                       | Purpose                                                                                        |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [`00-*.sh`](./00-bash-opts.sh)                                                             | Baseline shell options and hooks that must load first (bash opts, chpwd hook, `cd`, direnv).   |
| [`05-*.sh`](./05-ls.sh)                                                                    | `ls` defaults — before tool wrappers so `eza`/`fd`/etc. can override.                          |
| [`10-*.sh`](./10-fzf.sh)                                                                   | Tool integrations that mostly set env vars or aliases (`fzf`, `eza`, `fd`, `ripgrep`, `less`). |
| [`20-*.sh`](./20-nvm.sh)                                                                   | Heavy one-off integrations (`nvm`) that benefit from lazy loading.                             |
| [`30-*.sh`](./30-git.sh)                                                                   | Tool integrations with completion setup, pager configuration, or cache-backed rendering.       |
| [`80-*.sh`](./80-podman.sh), [`90-*.sh`](./90-docker.sh), [`90-termux.sh`](./90-termux.sh) | Platform / late-bound integrations run after most others.                                      |

## Key patterns

### Guard first

Every plugin starts with a `command -v <tool>` no-op guard:

```bash
command -v fzf &>/dev/null || return
```

Never crash the shell load because a plugin's tool is missing.

### Numeric prefix controls order

`00-` baseline + hooks, `05-` pre-tool defaults, `10-` env-var / alias integrations, `20-` lazy-loaded / heavy, `30-`
completion / pager / cache-backed, `80-`/`90-` platform or late-bound. Pick the earliest prefix that orders correctly;
re-numbering is expensive because `DOT_PLUGIN_DISABLE_<name>` strips the prefix from the basename.

### Respect existing state

Respect existing env vars (e.g. `: "${FZF_DEFAULT_OPTS:=…}"`). Users override in `~/.bash_local`; plugins stay additive.

### Header

Start with `# shellcheck shell=bash`, a one-line purpose, and `# SPDX-License-Identifier: MIT`. No shebang — plugins are
sourced.

### Disable surface

Each built-in plugin is disablable via `DOT_PLUGIN_DISABLE_<basename>=1`, basename stripped of the numeric prefix.
Document the disable switch in [`../REFERENCE.md`](../REFERENCE.md) when adding a new plugin.

## Boundaries

**Always**: guard with `command -v`; update [`../REFERENCE.md`](../REFERENCE.md)'s "Tool defaults" table when adding or
retargeting a plugin; ship shellcheck-clean code (`./dev/lint.sh` must pass); add a bats spec under
[`../tests/plugins/`](../tests/plugins/) for non-trivial behavior.

**Ask first**: adding a new numeric prefix tier; adding a plugin that loads by default (not gated behind
`DOT_INCLUDE_BUILTIN_PLUGINS=1`) — only two such plugins exist today (`00-bash-opts.sh`, `00-chpwd-hook.sh`).

**Never**: perform blocking network / subprocess work at source time (the plugin phase runs in every interactive shell);
assume a tool is on `$PATH` without `command -v`; edit files under [`../external/`](../external/) — wrap them from a
plugin instead.

## References

- [`../README.md`](../README.md) — plugin phase behaviour, `DOT_INCLUDE_BUILTIN_PLUGINS`, `DOT_PLUGIN_DISABLE_<name>`.
- [`../REFERENCE.md`](../REFERENCE.md) — "Tool defaults" table: every plugin and the tool it configures.
- [`../external/AGENTS.md`](../external/AGENTS.md) — vendored scripts that some plugins source (`git-prompt.sh`, etc.).
