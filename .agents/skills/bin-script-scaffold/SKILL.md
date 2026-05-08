---
name: bin-script-scaffold
description:
  'WHAT: Scaffold a new bin script in this dotfiles repo with the required sibling files: the script itself, a bash
  completion file, and a bats test, using genpasswd as the argparse reference. WHEN: User asks to add a new git
  subcommand, utility script, or any other executable under dotenv/bin or a platform-specific bin directory. DO-NOT:
  Skip the completion file or the bats test stub; do not invent a new argument-parsing style when the script takes
  flags; do not add scripts to external/ or to private __-prefixed paths without confirming intent.'
---

# Bin script scaffold

New executables in this repo ship as a trio: the script under a `bin/` directory, a sibling bash completion file under
the neighboring `completion/` directory, and a bats test mirroring the script path under `tests/`. All three land in the
same commit.

`dotenv/bin/genpasswd` is the canonical reference for argument parsing. Use it as the template; do not invent a new
style.

## When to use this skill

Apply this skill when the user asks to:

- Add a new utility script under `dotenv/bin/` or a platform bin directory (`dotenv/darwin/bin/`, `dotenv/linux/bin/`,
  `dotenv/wsl/bin/`, `dotenv/ssh/bin/`).
- Add a git subcommand (`dotenv/bin/git-*` or platform variant), invoked as `git <name>` once on `$PATH`.
- Promote an inline shell snippet or alias into a standalone executable.

Skip this skill when the user wants:

- A private internal helper (`__`-prefixed). Those do not need a completion file. Confirm the user actually wants a
  private script before scaffolding without one.
- A shell function or alias rather than a standalone executable. Functions and aliases live under `dotenv/functions` /
  `dotenv/aliases`, not `bin/`.

## File trio

For a script named `foo` placed at `dotenv/bin/foo`:

| File       | Path                         |
| ---------- | ---------------------------- |
| Script     | `dotenv/bin/foo`             |
| Completion | `dotenv/completion/foo.bash` |
| Test       | `tests/dotenv/bin/foo.bats`  |

For a script under a platform bin, the completion and test follow the same parallel layout, e.g. `dotenv/wsl/bin/foo`
pairs with `dotenv/wsl/completion/foo.bash` and `tests/dotenv/wsl/bin/foo.bats`.

## Script shape

Every script starts with:

```bash
#!/usr/bin/env bash
# One-line purpose.
# SPDX-License-Identifier: MIT

set -euo pipefail
IFS=$'\n\t'
```

Helper function names default to plain identifiers (`print_help`, `parse_args`). Use a script-specific prefix only when
it materially improves clarity or avoids collisions during test sourcing.

## Argument parsing

Two patterns; pick by what the script accepts.

### Help-only (no other flags)

A leading `case` on `$1` short-circuits help, then the rest of the script runs.

```bash
case "${1:-}" in
  -h | -\? | --help)
    print_help
    exit 0
    ;;
esac
```

### Multiple options

A `while` loop over `$@` with explicit cases. Support both `--flag value` and `--flag=value`, plus short forms like
`-l5` for single-letter flags. Print an error and exit 1 on unknown args. Always `exit 0` after `print_help`.

```bash
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | -\? | --help)
      print_help
      exit 0
      ;;
    -l | --length | --len)
      if [[ $# -lt 2 ]]; then
        echo "foo: missing value for $1" >&2
        exit 1
      fi
      LENGTH="$2"
      shift
      ;;
    -l?*)
      LENGTH="${1#-l}"
      ;;
    --length=* | --len=*)
      LENGTH="${1#*=}"
      ;;
    *)
      echo "foo: unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done
```

`dotenv/bin/genpasswd` shows the full pattern in context.

## Completion file

Every public script ships with a sibling completion. Name it `<script>.bash` and define a `_dot_<name>` function wired
up with `complete -F`.

For scripts with positional args, flag values, or subcommand verbs, write a real completion function:

```bash
# shellcheck shell=bash
# Bash completion for foo.
# SPDX-License-Identifier: MIT

_dot_foo() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"

  case "${prev}" in
    -l | --length | --len)
      return
      ;;
  esac

  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-l --length --len -h --help" -- "${cur}")
  fi
}
complete -F _dot_foo foo
```

For flag-only or trivial wrappers, the `complete -W` shortcut is fine. Add `-o default` if file completion should still
kick in for non-flag words:

```bash
complete -W "--help --version" -o default foo
```

Private `__`-prefixed scripts do not need completion files.

## Test stub

Tests mirror the script path: `dotenv/bin/foo` lands at `tests/dotenv/bin/foo.bats`. Test names start with the script
name and a colon. Source helpers from `tests/helpers/common.bash`.

```bash
#!/usr/bin/env bats
# Tests for dotenv/bin/foo.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/bin/foo"
}

@test "foo: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: foo"
  done
}

@test "foo: unknown argument exits 1" {
  run bash "${SCRIPT}" --not-a-flag
  assert_failure
  assert_output --partial "unknown argument"
}
```

For internal-function unit tests, use `source_without_main` (see `TESTING.md`) instead of invoking the script as a
subprocess.

## Workflow

1. Confirm the placement: `dotenv/bin/` for cross-platform, `dotenv/<platform>/bin/` for platform-specific. Confirm
   whether the script should be public or private (`__`-prefixed).
2. Write the script with the standard header, `set -euo pipefail`, and the genpasswd-style argparse pattern that matches
   its flag surface.
3. Write the sibling completion file under the parallel `completion/` directory. Skip this only for `__`-prefixed
   private scripts.
4. Write the bats test under the mirrored path with at minimum a help-output test and an unknown-argument test. Add
   behavior tests for the script's actual logic.
5. `chmod +x` the script.
6. Update `REFERENCE.md`'s `## Commands on PATH` (and `## Git aliases` for `git-*` subcommands) per the `doc-sync`
   skill.
7. Run `./dev/lint.sh` and `./dev/test-docker.sh tests/<path>/foo.bats` before committing.

## Common pitfalls

- Forgetting the completion file. Lint will not catch it; reviewers will.
- Inventing a new argparse style. Stick to the genpasswd pattern; consistency across the repo is the point.
- Missing `chmod +x`. Bats tests will pass via `bash "${SCRIPT}"`, but the script will not run from `$PATH`.
- Putting tests under `tests/bin/` instead of mirroring the source path. Tests must mirror.
- Skipping the `REFERENCE.md` update; that step belongs to the same commit.
