---
name: plugin-conventions
description:
  "WHAT: Conventions for files under plugins/ - numeric prefix for load order, `command -v` guard, disable-switch
  contract, no-blocking-work-at-source-time rule. WHEN: User asks to add a new plugin, move an integration into a
  plugin, or debug why a plugin isn't loading. DO-NOT: Skip the `command -v` guard; perform network/subprocess work at
  source time; invent a new numeric tier without asking; assume the plugin loads by default (only `00-bash-opts.sh` and
  `00-chpwd-hook.sh` do)."
---

# Plugin Conventions

Plugins under `plugins/` integrate one external tool each. They load during the `plugin` phase of the dotenv chain -
after `completion`, before `prompt` - in basename order. Getting the shape right is what makes them cheap to have on
every shell.

## When this applies

- Adding a new integration for a CLI tool (`fzf`, `direnv`, `bat`, `kubectl`, …).
- Moving setup code out of a phase file and into a plugin because it's becoming too large or is opt-in.
- Debugging "my plugin isn't loading" / "shell startup got slow".

## The file shape

Every plugin starts with this exact header and guard - copy it verbatim, only swap `<tool>` and the purpose line:

```bash
# shellcheck shell=bash
# <One-line purpose>.
# SPDX-License-Identifier: MIT

# @see https://<upstream-url>
command -v <tool> &>/dev/null || return
```

No shebang. Plugins are sourced, not executed. The guard is one line: `command -v <tool> &>/dev/null || return` - do NOT
drop the `|| return` tail, and do NOT expand it into a multi-line `if ! command -v …; then return; fi` block unless you
need to do extra cleanup in the miss path. The one-liner is what every other plugin uses; consistency makes missing
guards obvious in review.

## Numeric prefix tiers

The numeric prefix controls load order. Pick the earliest tier that orders correctly. Reusing an existing tier is
cheaper than inventing a new one - `DOT_PLUGIN_DISABLE_<name>` strips the prefix, so renumbering later is disruptive.

| Prefix | What lives here                                                                     |
| ------ | ----------------------------------------------------------------------------------- |
| `00-`  | Baseline shell options and hooks that must load first (`bash-opts`, `chpwd-hook`).  |
| `05-`  | Pre-tool defaults, before tool wrappers can override them (`ls`).                   |
| `10-`  | Env-var / alias integrations - most tools (`fzf`, `eza`, `ripgrep`, `bat`, `less`). |
| `20-`  | Heavy or lazy-loaded integrations (`nvm`).                                          |
| `30-`  | Completion / pager / cache-backed integrations (`git`, `gh`, `npm`, `delta`).       |
| `80-`  | Container runtimes (`podman`).                                                      |
| `90-`  | Platform / late-bound (`docker`, `termux`).                                         |

Adding a new tier number (e.g. `40-`, `50-`, `60-`) changes the mental model - ask the user first.

## Disable switch

Each plugin is disablable via `DOT_PLUGIN_DISABLE_<basename>=1`, with the numeric prefix stripped from the basename:

- `plugins/10-fzf.sh` → `DOT_PLUGIN_DISABLE_fzf=1`
- `plugins/30-git.sh` → `DOT_PLUGIN_DISABLE_git=1`

Document the disable knob in `REFERENCE.md` when adding a new plugin.

## Load-by-default vs opt-in

Only two plugins load by default: `00-bash-opts.sh` and `00-chpwd-hook.sh`. Everything else requires
`DOT_INCLUDE_BUILTIN_PLUGINS=1` in the user's environment. Adding a new default-loaded plugin is a big deal - **ask
first**.

## Respect existing state

Users override behavior in `~/.bash_local` or `~/.bash_local.d/*.sh`, sourced before plugins run. Your plugin must be
additive - never clobber an already-set value.

```bash
# Good: only sets if the user hasn't already.
: "${FZF_DEFAULT_OPTS:=--height 40% --reverse}"

# Bad: always overwrites, breaks user customization.
export FZF_DEFAULT_OPTS="--height 40% --reverse"
```

## No blocking work at source time

Plugins run in every interactive shell. Slow plugins mean slow shells. At source time you may:

- Set env vars, aliases, define functions.
- Register completions.
- `source` lightweight shell files.

You may **not**:

- Make network calls.
- Call `$(command ...)` subprocesses that take more than a few ms.
- Run any loop you wouldn't want on every `cd` into a directory that opens a new terminal.

If a plugin needs expensive work, lazy-load it via a wrapper function that runs the setup the first time the command is
invoked.

## Tests

Non-trivial plugins get a bats spec under `tests/plugins/<basename>.bats` - note the `.bats` extension, matching the
source basename (prefix included). Example: `plugins/30-zoxide.sh` → `tests/plugins/30-zoxide.bats`. See the
`bats-test-conventions` skill.

## Anti-patterns

- **No `command -v` guard.** Shell startup crashes when the tool isn't installed.
- **Expensive subprocess calls at source time.** `$(kubectl version)` on every shell start adds 500ms+.
- **Clobbering existing env vars.** Use `: "${VAR:=default}"` instead of `export VAR=default`.
- **Using a made-up tier.** `45-foo.sh` works functionally but breaks the shared load-order mental model.
- **Duplicating a phase-file responsibility.** A simple alias belongs in `dotenv/aliases.sh`, not a plugin. Plugins are
  for tool integrations where `command -v` guarding and opt-in loading matter.
- **Skipping the `REFERENCE.md` update.** Every new plugin row belongs in the Tool defaults table.
- **Editing `external/` from a plugin.** Wrap it instead; never modify vendored files in place.

## Workflow

1. Confirm the tier: scan `plugins/` for a similar plugin and match its prefix.
2. Write the file with the header, guard, and additive setup.
3. Add `DOT_PLUGIN_DISABLE_<name>=1` support documentation in `REFERENCE.md`.
4. Add a bats spec under `tests/plugins/<basename>.bats` if behavior is non-trivial.
5. `./dev/lint.sh` and (if tests exist) `./dev/test-docker.sh tests/plugins/<basename>.bats`.
6. Smoke test: `DOT_INCLUDE_BUILTIN_PLUGINS=1 env -i PATH="$PATH" HOME="$HOME" bash -l`.
