# Tests

Bats test suite for the dotfiles, plus a small vitest suite for TypeScript helpers under `lib/node/`. Bats tests run in
Docker (`ubuntu:24.04`) for isolation. See root [AGENTS.md](../AGENTS.md) for project-wide conventions; this file only
documents what is different in this directory. See [TESTING.md](../TESTING.md) for the full helper API, examples, and
worked test-file anatomy.

## Commands

- `./dev/test-docker.sh tests/dotenv/bin/git-sync.bats` — run a single test file.
- `./dev/test-docker.sh tests/dotenv/bin/` — run all tests in a directory.
- `./dev/test-docker.sh -q` — quiet mode, only failures and summary.
- `npm test` — run the vitest suite (`tests/**/*.spec.ts`).
- `npx vitest run tests/lib/node/pi/jsonc.spec.ts` — run a single vitest spec.
- `npx vitest tests/lib/node/pi/jsonc.spec.ts` — watch mode for a single spec.

## Directory map

Tests mirror the source tree under [`../dotenv/`](../dotenv/) and [`../lib/node/`](../lib/node/). Key sub-paths:

| Path                                                                                                                                                                                                                                                   | Purpose                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| [`helpers/common.bash`](./helpers/common.bash)                                                                                                                                                                                                         | Shared setup: mock stubs, git helpers, isolated HOME.                                                     |
| [`dotenv/bin/`](./dotenv/bin)                                                                                                                                                                                                                          | Tests for standalone `bin/` scripts.                                                                      |
| [`dotenv/lib/`](./dotenv/lib)                                                                                                                                                                                                                          | Tests for internal library functions.                                                                     |
| [`dotenv/linux/`](./dotenv/linux), [`dotenv/darwin/`](./dotenv/darwin), [`dotenv/wsl/`](./dotenv/wsl), [`dotenv/wsl2/`](./dotenv/wsl2), [`dotenv/ssh/`](./dotenv/ssh), [`dotenv/tmux/`](./dotenv/tmux)                                                 | Platform-specific tests.                                                                                  |
| [`dotenv/aliases.bats`](./dotenv/aliases.bats), [`dotenv/functions.bats`](./dotenv/functions.bats), [`dotenv/exports.bats`](./dotenv/exports.bats), [`dotenv/completion.bats`](./dotenv/completion.bats), [`dotenv/prompt.bats`](./dotenv/prompt.bats) | Tests for top-level dotenv layout files.                                                                  |
| [`lib/node/pi/`](./lib/node/pi)                                                                                                                                                                                                                        | Vitest specs for pure helpers under [`lib/node/pi/`](../lib/node/pi) ([README](./lib/node/pi/README.md)). |

## Key patterns

Tests mirror source paths: `dotenv/bin/git-sync` → `tests/dotenv/bin/git-sync.bats`. Prefix `@test` names with the
script name and colon, e.g. `@test "git-sync: restores dirty state"`.

- **Bin scripts**: `run bash "${SCRIPT}" args`. Use `source_without_main` to unit-test internal functions without
  triggering the entrypoint.
- **Sourced files**: `source "${REPO_ROOT}/dotenv/linux/aliases.sh"` directly in `setup()`, then exercise the aliases /
  functions.
- **Git-dependent**: `init_git_repo` / `init_bare_git_repo` for deterministic repos; `setup_isolated_home` to keep host
  git config out of the test.
- **Command stubs**: `setup_test_bin` then `stub_command <name> <<'EOF'`. For WSL tests, `setup_mock_bin` provides
  `wslpath`, `cmd.exe`, `powershell.exe`.
- **Assertions**: prefer `assert_success` / `assert_failure` / `assert_output` / `assert_line`; fall back to
  `[[ "${output}" =~ pattern ]]` for regex.
- **Isolation**: `BATS_TEST_TMPDIR` for temp files; `setup_isolated_home` whenever tests touch `HOME` or git globals;
  `use_mock_bin_path` to restrict `PATH` when testing command resolution.

See [tests/dotenv/bin/git-sync.bats](./dotenv/bin/git-sync.bats) for a full git-dependent example and
[TESTING.md](../TESTING.md) for the complete helper API.

## Boundaries

**Always**: use 2-space indentation; prefix `@test` names with `"script-name: description"`; load `helpers/common` in
`setup()`.

**Ask first**: adding a new helper to `helpers/common.bash` (prefer a test-file–local function first); changing the
Docker base image or bats version in [`../dev/Dockerfile.test`](../dev/Dockerfile.test).

**Never**: depend on host-installed tools — stub external commands; write to real `HOME` — use `setup_isolated_home`.

## References

- [helpers/common.bash](./helpers/common.bash) — full helper API and stub implementations.
- [TESTING.md](../TESTING.md) — framework overview, Docker image, helper tables, mock behavior, test-file anatomy
  examples.
- [lib/node/pi/README.md](./lib/node/pi/README.md) — vitest suite overview for the TypeScript helpers.
