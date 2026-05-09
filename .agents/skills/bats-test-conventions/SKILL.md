---
name: bats-test-conventions
description:
  "WHAT: Conventions for bats tests in this repo — file path mirroring, `@test` naming, which helpers from
  tests/helpers/common.bash to use, when to use source_without_main vs subprocess invocation. WHEN: User asks to add or
  edit a `.bats` test file anywhere under tests/. DO-NOT: Put tests under tests/bin/ instead of mirroring the source
  path; invent new helper names when common.bash already has one; rely on the host's real `git` / `curl` / `ssh` — stub
  them."
---

# Bats Test Conventions

Bats covers the shell side of this repo (scripts, plugins, phase files). TypeScript helpers under `lib/node/` use vitest
instead — don't mix them. TESTING.md has the full helper catalog; this skill is the short version.

## When this applies

- Adding a new `.bats` file for a script / plugin / phase-file change.
- Editing an existing `.bats` file and wondering which helper to use.
- Deciding whether a new test should be a subprocess run or a sourced unit test.

Skip this skill for `*.spec.ts` vitest specs — use the `ts-vs-bats-router` skill instead.

## File path mirrors source path

The test file path is the source file path, with `tests/` prepended and `.bats` appended:

| Source                | Test                            |
| --------------------- | ------------------------------- |
| `dotenv/bin/foo`      | `tests/dotenv/bin/foo.bats`     |
| `dotenv/wsl/bin/foo`  | `tests/dotenv/wsl/bin/foo.bats` |
| `dotenv/aliases.sh`   | `tests/dotenv/aliases.bats`     |
| `plugins/10-fzf.sh`   | `tests/plugins/10-fzf.bats`     |
| `dotenv/functions.sh` | `tests/dotenv/functions.bats`   |

Do NOT put tests under `tests/bin/` or `tests/scripts/`. Reviewers expect to navigate by parallel path.

## @test naming — REQUIRED prefix

Every `@test` block starts with the script or feature name followed by `:` (colon + space) and a short description. This
is not optional — it's how test grep works in this repo.

```bash
@test "git-sync: prints help with -h" { ... }
@test "git-sync: restores stash on failure" { ... }
@test "10-fzf: skips when fzf binary is absent" { ... }
```

Derive the prefix from the source basename without extension:

| Source                       | `@test` prefix |
| ---------------------------- | -------------- |
| `dotenv/bin/git-sync`        | `git-sync:`    |
| `dotenv/bin/genpasswd`       | `genpasswd:`   |
| `plugins/10-fzf.sh`          | `10-fzf:`      |
| `dotenv/functions.sh::foo()` | `foo:`         |

That prefix makes test grep usable (`./dev/test-docker.sh -q | grep git-sync`). Tests without the prefix pass CI but
will be flagged in review.

## The two-helper starting set

Every test file sources `tests/helpers/common.bash`. In `setup()`, bats' `load` drops the `.bash` extension for you, so
you write `load '../../helpers/common'` — but when referring to the file itself in documentation or comments, always
call it `tests/helpers/common.bash` (the actual on-disk filename):

```bash
setup() {
  load '../../helpers/common'   # bats auto-appends .bash
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/bin/foo"
}
```

The helpers you reach for first:

| Helper                | What it does                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `setup_test_bin`      | Creates `$BATS_TEST_TMPDIR/bin`, prepends to `$PATH`. Subsequent `stub_command` writes land there.           |
| `stub_command <name>` | Reads a heredoc from stdin, writes it as `$MOCK_BIN/<name>`, makes executable. Use to stub `git`/`curl`/etc. |
| `setup_isolated_home` | Points `$HOME` / `$XDG_CONFIG_HOME` at a temp dir, unsets system git config. Use when tests touch `$HOME`.   |
| `prepend_path`        | Shortcut for putting an arbitrary dir at the front of `$PATH`.                                               |
| `source_without_main` | Sources a script WITHOUT running its main body, so unit-tested functions are accessible.                     |

Before adding a helper of your own, `rg -n "^[a-z_]+ *()" tests/helpers/common.bash` — odds are it exists.

## Subprocess vs sourced

- **Subprocess (`run bash "${SCRIPT}" …`).** Default for end-to-end tests: argparse, help output, error exits,
  external-command stubs. Tests match what users see when invoking the script.
- **Sourced via `source_without_main`.** Use when unit-testing internal helper functions. Skips the script's main body
  so you can call the helper directly with its own args. See TESTING.md for the marker-comment convention that makes
  `source_without_main` work.

Rule of thumb: test the public CLI behavior via subprocess; test internal logic via source. Cover both for non-trivial
scripts.

## Stubbing externals

Any external command a script runs is a liability. Stub it.

```bash
@test "git-sync: bails when no remote is set" {
  stub_command git <<'EOF'
#!/usr/bin/env bash
case "$1" in
  remote) exit 0 ;;   # prints nothing, exits 0 → no remote
  *) echo "unexpected git call: $*" >&2; exit 2 ;;
esac
EOF

  run bash "${SCRIPT}"
  assert_failure
  assert_output --partial "no remote"
}
```

Never rely on the host's real `git`, `curl`, `ssh`, `openssl`, `gh`. Even in CI they produce different output across
versions.

## Assertions

`bats-assert` is loaded by `common.bash`. Use the named helpers, not raw `[[ ]]`:

- `assert_success` / `assert_failure` (exit-code checks).
- `assert_output --partial "<text>"` / `assert_output "<exact>"`.
- `assert_line "<text>"` / `refute_line "<text>"`.

Plain `[ "$status" -eq 0 ]` works but gives worse failure messages.

## Running tests

| Goal                                  | Command                                          |
| ------------------------------------- | ------------------------------------------------ |
| Full suite in Docker (recommended)    | `./dev/test-docker.sh`                           |
| Quiet mode                            | `./dev/test-docker.sh -q`                        |
| Single file                           | `./dev/test-docker.sh tests/dotenv/bin/foo.bats` |
| Whole subtree                         | `./dev/test-docker.sh tests/plugins/`            |
| Local run (needs host bats + helpers) | `./dev/test.sh`                                  |

Prefer Docker — it pins the bats / bats-assert version and sidesteps host drift.

## Anti-patterns

- **Tests under `tests/bin/`** instead of mirroring the source path. Reviewers can't find them.
- **Relying on real `git` / `curl` in CI.** Stub them.
- **Tests that `cd` into the repo root without restoring `$PWD`.** Use `$BATS_TEST_TMPDIR` as the working dir.
- **Sharing state between `@test` blocks.** Each `@test` gets a fresh `$BATS_TEST_TMPDIR`; if you need shared fixtures,
  create them in `setup_file` (see bats docs) or per-test in `setup`.
- **Skipping helper reuse — writing `mkdir -p "$HOME/.config" …` inline** when `setup_isolated_home` does it.
- **Asserting on exact output when the script emits version-dependent strings.** Use `--partial`.
- **Inventing a new prefix style.** `<script>:` is the repo convention.

## Quick reference

| Situation                                    | Move                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| New `dotenv/bin/foo`                         | `tests/dotenv/bin/foo.bats` with help + unknown-arg tests minimum.        |
| New plugin `plugins/30-foo.sh`               | `tests/plugins/30-foo.bats` with the "tool absent → no-op" test.          |
| Testing a shell function from `functions.sh` | `source_without_main` in `setup`, call the function directly, assert.     |
| Script calls `git` / `curl`                  | `stub_command git <<'EOF' … EOF` with only the cases your test exercises. |
| Script writes to `$HOME`                     | `setup_isolated_home` before the run.                                     |
