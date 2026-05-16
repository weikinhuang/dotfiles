---
name: dotenv-phase-placement
description:
  'WHAT: Decide which dotenv phase file and which platform subdirectory a new alias, function, export, or completion
  belongs in. WHEN: User asks to add (or move) an alias, shell function, env var, or completion in this dotfiles repo.
  DO-NOT: Put platform-specific code in shared phase files with runtime `uname` checks; do not invent new phase file
  names (`lib/load.sh` only loads the seven canonical ones); do not put `bin/` scripts in phase files.'
---

# Dotenv Phase Placement

Every user-facing shell addition lands in a specific phase file inside a specific directory under `dotenv/`. Pick wrong
and either the thing doesn't load, or it loads at the wrong time, or it leaks across platforms. This skill is the
decision tree.

## The seven phase files

In every `dotenv/` directory (including platform subdirs) up to seven phase files load, always in this order:

```text
exports → functions → aliases → extra → env → completion → prompt
```

| Phase file      | What goes here                                                                |
| --------------- | ----------------------------------------------------------------------------- |
| `exports.sh`    | `export FOO=bar` lines, `PATH` additions, anything that sets environment.     |
| `functions.sh`  | Shell function definitions (`function foo() { … }`).                          |
| `aliases.sh`    | `alias ll='ls -la'` lines.                                                    |
| `extra.sh`      | Miscellaneous setup that doesn't fit another phase. Use sparingly.            |
| `env.sh`        | Runtime environment mutations that must happen after aliases/functions exist. |
| `completion.sh` | Completion loading / `complete -F` setup for shell commands.                  |
| `prompt.sh`     | `PS1` / prompt segment configuration.                                         |

Only create the files you actually need. `lib/load.sh` no-ops missing ones.

## The platform chain

Directories load in this order, each adding to (not replacing) the previous layer:

```text
dotenv/           (always)
dotenv/darwin/    (macOS only)
dotenv/linux/     (Linux only)
dotenv/wsl/       (WSL - loaded on top of linux/)
dotenv/wsl2/      (WSL 2 - loaded on top of wsl/)
dotenv/tmux/      (only inside tmux)
dotenv/screen/    (only inside GNU screen)
dotenv/ssh/       (only inside an SSH session)
```

Rule: if the addition is platform-specific, put it in the platform subdir's phase file - never in a shared file guarded
with `if [[ "$(uname)" == Darwin ]]`. The platform chain already does that dispatch.

## Decision tree

Answer in order; first match wins.

1. **Is it a standalone executable you'd invoke as `foo args`?** → Not a phase file. Scaffold a `bin/` script; use the
   `bin-script-scaffold` skill.
2. **Is it a private loader internal (`__dot_*` / `internal::*`)?** → `dotenv/lib/` (or the neighboring `lib/` under a
   platform dir). Not a phase file.
3. **Does it only make sense on one platform?** → Phase file under the matching platform subdir (`dotenv/darwin/`,
   `dotenv/linux/`, `dotenv/wsl/`, `dotenv/wsl2/`). Same phase-file name rules below.
4. **Does it only matter inside an SSH / tmux / screen session?** → Phase file under `dotenv/ssh/`, `dotenv/tmux/`, or
   `dotenv/screen/`.
5. **Does it set an env var or `PATH`?** → `exports.sh` in the appropriate directory.
6. **Is it a function definition?** → `functions.sh`.
7. **Is it an alias (`alias x='...'`)?** → `aliases.sh`.
8. **Is it a `complete -F` / `complete -W` registration or a completion script source?** → `completion.sh`.
9. **Does it touch the prompt or `PS1`?** → `prompt.sh`.
10. **Does it need to run after aliases/functions exist (e.g. calls a function defined earlier)?** → `env.sh`.
11. **None of the above fit cleanly?** → `extra.sh`, and leave a one-line comment explaining why it doesn't fit
    elsewhere.

## Common placements

| Addition                                     | File                                        |
| -------------------------------------------- | ------------------------------------------- |
| `export EDITOR=vim`                          | `dotenv/exports.sh`                         |
| `alias ll='ls -la'`                          | `dotenv/aliases.sh`                         |
| `function git-recent() { … }`                | `dotenv/functions.sh`                       |
| `complete -F _dot_mything mything`           | `dotenv/completion.sh`                      |
| macOS-only `export HOMEBREW_NO_ANALYTICS=1`  | `dotenv/darwin/exports.sh`                  |
| Linux-only `alias open='xdg-open'`           | `dotenv/linux/aliases.sh`                   |
| `PATH` addition for `/mnt/c/...` on WSL      | `dotenv/wsl/exports.sh`                     |
| SSH-only `function forward-port() { … }`     | `dotenv/ssh/functions.sh`                   |
| A `git-sync` command-line tool               | `dotenv/bin/git-sync` (NOT a phase)         |
| Private helper `__dot_prompt_color_for_host` | `dotenv/lib/prompt-colors.sh` (NOT a phase) |

## Mirror the test path

When phase-file additions are non-trivial (a new shell function with logic, a completion registration, a prompt hook),
the matching test lives under `tests/<same path>`:

- `dotenv/darwin/aliases.sh` → `tests/dotenv/darwin/aliases.bats`
- `dotenv/functions.sh` → `tests/dotenv/functions.bats`

**Do NOT create or extend a bats test file for a trivial one-line addition** (a plain alias, a single `export VAR=val`,
or a simple platform path tweak). The existing phase-file tests already cover load semantics; adding a new `@test` block
per alias bloats the suite without catching anything. Add behavior tests when the addition has logic worth exercising.
See the `bats-test-conventions` skill for when and how.

## Anti-patterns

- **Runtime `uname` check in a shared file.** Move to a platform subdir; that's what the subdir chain is for.
- **Cross-phase dependencies.** Defining an alias in `functions.sh` or vice versa - it'll load at the wrong time.
  Respect the phase order.
- **New phase file names.** `lib/load.sh` hard-codes the seven listed above; a made-up name silently doesn't load.
  Adding a new phase requires coordinated changes to `lib/load.sh` - ask first.
- **`export` inside `functions.sh`.** Belongs in `exports.sh` so it's available before functions are sourced.
- **Forgetting a platform chain means WSL gets `linux/` AND `wsl/`.** If the addition is WSL-only, put it in
  `dotenv/wsl/`, not duplicated under `dotenv/linux/`.

## Update the public surface

After adding or renaming anything user-facing in a phase file, follow the `doc-sync` skill: update `REFERENCE.md`
(aliases, functions, env vars, hooks all go in their named tables) and, for new `DOT_*` / `BASHRC_*` knobs, update
`README.md`'s Configuration Options table in lockstep.
