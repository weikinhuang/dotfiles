#!/usr/bin/env bats
# Tests for AGENTS.md.
# SPDX-License-Identifier: MIT

Bats test suite for the dotfiles. Tests run in Docker (`ubuntu:24.04`) for isolation. See root [AGENTS.md](../AGENTS.md) for project-wide conventions.

## Commands

- `./dev/test-docker.sh tests/dotenv/bin/git-sync.bats` -- run a single test file
- `./dev/test-docker.sh tests/dotenv/bin/` -- run all tests in a directory
- `./dev/test-docker.sh -q` -- quiet mode, only failures and summary

## Directory map

| Path | Purpose |
| --- | --- |
| `helpers/common.bash` | All shared setup functions, stubs, and git helpers |
| `dotenv/bin/` | Tests for standalone bin scripts |
| `dotenv/lib/` | Tests for internal library functions |
| `dotenv/{linux,darwin,wsl,wsl2,ssh}/` | Platform-specific tests |
| `dotenv/{aliases,functions,exports,completion,prompt}.bats` | Tests for top-level dotenv layout files |

## Test file anatomy

```bash
#!/usr/bin/env bats

setup() {
  load '../../helpers/common'   # adjust depth to match
  setup_test_bin                # or setup_mock_bin for WSL tests
  SCRIPT="${REPO_ROOT}/dotenv/bin/my-script"
}

@test "my-script: describes the behavior" {
  run bash "${SCRIPT}" arg1
  assert_success
  assert_output "expected"
}
```

See `path:tests/dotenv/bin/git-sync.bats` for a full git-dependent example with repo setup helpers, stash/restore verification, and `source_without_main` usage.

## Patterns

### Bin script tests

Test standalone scripts with `run bash "${SCRIPT}" args`. Use `source_without_main` to unit-test internal functions without triggering the entrypoint.

### Sourced file tests

Source the file directly in `setup()` then call its functions: `source "${REPO_ROOT}/dotenv/linux/aliases.sh"`. For dotenv layout files that define aliases, use `run <alias-name>` after sourcing.

### Git-dependent tests

Use `init_git_repo`/`init_bare_git_repo` for deterministic repos with test identity. Call `setup_isolated_home` to prevent host git config leakage. Place reusable repo-creation logic in a helper function (e.g. `create_origin_clone()`) at the top of the file to keep individual tests focused.

### Command stubs

Call `setup_test_bin` first, then create fakes with `stub_command <name> <<'EOF'`. Common variants: `stub_passthrough_command` (prints args), `stub_fixed_output_command` (returns fixed string), `stub_env_passthrough_command` (prints env var + args). For WSL tests, `setup_mock_bin` provides `wslpath`, `cmd.exe`, and `powershell.exe` stubs. For WSL path translation tests, use `setup_mock_windows_root` + `stub_mock_wslpath`.

### Assertions

Use `run` + `assert_success`/`assert_failure` for exit codes. `assert_output` for exact match, `assert_output --partial` for substring, `assert_line --index N` for specific lines. For regex matching use `[[ "${output}" =~ pattern ]]` directly.

### Isolation

Tests use `BATS_TEST_TMPDIR` for temp files (auto-cleaned by bats). Call `setup_isolated_home` when tests touch `HOME`, git global config, or `XDG_CONFIG_HOME`. Use `use_mock_bin_path` to restrict `PATH` to only `MOCK_BIN` + `/bin` when testing command resolution behavior.

## Boundaries

**Always**: use 2-space indentation; prefix `@test` names with `"script-name: description"`; load `helpers/common` in `setup()`.

**Never**: depend on host-installed tools -- stub external commands; write to real `HOME` -- use `setup_isolated_home`.

## References

- [helpers/common.bash](./helpers/common.bash) -- full helper API and stub implementations
- [TESTING.md](../TESTING.md) -- framework overview, Docker image, helper tables, mock behavior
