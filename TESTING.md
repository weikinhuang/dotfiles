# Testing

Tests are written with [bats-core](https://github.com/bats-core/bats-core) (Bash Automated Testing System) and use the
[bats-support](https://github.com/bats-core/bats-support) and [bats-assert](https://github.com/bats-core/bats-assert)
helper libraries for assertions.

Tests run inside a Docker container to provide a clean, isolated environment free of host-specific tools (e.g. `sshd`,
`cmd.exe`, WSL utilities) that could interfere with mocked dependencies.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)

## Running Tests

### Full suite (recommended)

```bash
./dev/test-docker.sh
```

### Quiet mode

Only prints failing tests and a summary line - useful for CI and agents:

```bash
./dev/test-docker.sh -q
```

### Single file

```bash
./dev/test-docker.sh tests/dotenv/wsl/bin/winrun.bats
```

### Run locally (without Docker)

Requires `bats`, `bats-support`, and `bats-assert` installed via apt:

```bash
sudo apt install bats bats-support bats-assert
./dev/test.sh
```

## Test Layout

Tests mirror the source directory structure:

```text
tests/
  helpers/
    common.bash                  # shared setup: mock stubs, bats library loading
  dotenv/
    bin/
      git-changelog.bats        # tests for dotenv/bin/git-changelog
      git-default-branch.bats   # tests for dotenv/bin/git-default-branch
      ...                        # one .bats file per script in dotenv/bin/
    wsl/
      bin/
        winrun.bats              # tests for dotenv/wsl/bin/winrun
        winstart.bats            # tests for dotenv/wsl/bin/winstart
        winsudo.bats             # tests for dotenv/wsl/bin/winsudo
  plugins/
    ...
```

## Writing Tests

### Conventions

- Place test files alongside their source counterpart under `tests/`, using the `.bats` extension.
- Use `setup()` to call `load '../../helpers/common'` (adjust depth to match).
- Use 2-space indentation in `.bats` and helper `.bash` files (enforced by `shfmt -i 2`).
- Prefix every `@test` name with the script name and a colon, e.g. `@test "git-sync: restores dirty changes ..."`.
- Use `run` + `assert_success` / `assert_failure` / `assert_output` / `assert_line` for assertions.
- Use `source_without_main` to unit-test internal functions without triggering the script's entrypoint.
- Prefer real operations (actual git repos, real files) over mocking when feasible. Use `init_git_repo` and friends to
  set up deterministic repos.
- When a test needs external commands stubbed out, use `setup_test_bin` + `stub_command` to create lightweight fakes.
- When a test writes to `HOME` or reads git global config, use `setup_isolated_home` to prevent host/system config
  leakage.
- Place reusable repo-creation logic in a helper function at the top of the file (e.g. `create_origin_clone()`) to keep
  individual tests focused.
- Add a `teardown()` function when tests start background processes to ensure cleanup.

### Example: Simple Script Test

```bash
#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_mock_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/my-script"
}

@test "my-script: no arguments prints usage" {
  run bash "${SCRIPT}"
  assert_failure
  assert_output --partial "Usage:"
}

@test "my-script: passes arguments through" {
  run bash "${SCRIPT}" hello world
  assert_success
  assert_line "hello"
}
```

### Example: Git-Dependent Script Test

```bash
#!/usr/bin/env bats

setup() {
  load '../../helpers/common'
  setup_test_bin
  setup_isolated_home
  prepend_path "${REPO_ROOT}/dotenv/bin"
  SCRIPT="${REPO_ROOT}/dotenv/bin/git-my-tool"
}

create_test_repo() {
  TEST_REPO="${BATS_TEST_TMPDIR}/repo"
  init_git_repo "${TEST_REPO}"
  echo "base" >"${TEST_REPO}/tracked.txt"
  git_commit_all "${TEST_REPO}" "initial commit"
}

@test "git-my-tool: detects default branch" {
  create_test_repo
  cd "${TEST_REPO}"
  run bash "${SCRIPT}"
  assert_success
  assert_output "main"
}
```

### Available Helpers

Defined in `tests/helpers/common.bash`:

#### General

| Helper                | Description                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `setup_test_bin`      | Creates `MOCK_BIN` temp directory and prepends it to `PATH`. Call before `stub_command` or any manual stub creation. |
| `prepend_path <dir>`  | Prepends an arbitrary directory to `PATH`.                                                                           |
| `setup_isolated_home` | Sets `HOME`, `XDG_CONFIG_HOME`, and `GIT_CONFIG_NOSYSTEM=1` to a temp directory, preventing host config leakage.     |
| `stub_command <name>` | Writes an executable stub into `MOCK_BIN` from stdin (use with a heredoc). Requires `setup_test_bin` first.          |
| `source_without_main` | Sources a script without executing its final entrypoint line, allowing individual functions to be called in tests.   |

#### WSL Mocks

| Helper                 | Description                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `setup_mock_bin`       | Calls `setup_test_bin`, then creates stubs for `wslpath`, `cmd.exe`, and `powershell.exe`. |
| `setup_mock_cmd_stdin` | Replaces the `cmd.exe` stub with one that also forwards stdin.                             |

#### Git Helpers

| Helper                               | Description                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `init_git_repo <path> [branch]`      | Creates a non-bare repo with a deterministic test identity. Default branch is `main`.                  |
| `init_bare_git_repo <path> [branch]` | Creates a bare repo (for use as a remote). Default branch is `main`.                                   |
| `configure_git_identity <path>`      | Sets `user.name` and `user.email` to test values in an existing repo.                                  |
| `git_commit_all <path> <message>`    | Stages all changes and commits with `--no-gpg-sign`.                                                   |
| `add_git_exec_path`                  | Prepends `git --exec-path` to `PATH`, making helpers like `git-sh-setup` available to sourced scripts. |

### Mock Behavior

| Mock             | Behavior                                          |
| ---------------- | ------------------------------------------------- |
| `wslpath`        | `/mnt/x/rest` → `X:\rest`, all others → `C:\path` |
| `cmd.exe`        | Prints each argument on its own line              |
| `powershell.exe` | Prints each argument on its own line              |

## Linting

[shellcheck](https://github.com/koalaman/shellcheck) and [shfmt](https://github.com/mvdan/sh) validate all shell
scripts. Bats files are formatted with `shfmt -ln bats` and also checked by ShellCheck using its Bats parser
(`shellcheck -s bats -S warning`).

```bash
./dev/lint.sh
```

## Docker Image

The test image (`dev/Dockerfile.test`) is built from `ubuntu:24.04` and installs the Bats tooling, shell lint/format
tools, and a small set of utilities used by tests and validation, including `git`, `tmux`, `powerline`, `vim`, and
`neovim`. The repo is bind-mounted read-only at `/dotfiles`.

## Interactive Development Shell

To manually test dotfiles, plugins, or hooks in an isolated environment:

```bash
docker run -it --rm \
  -v "$(pwd):/root/.dotfiles:ro" \
  -v "$HOME/.bash_local:/root/.bash_local:ro" \
  -v "$HOME/.bash_local.d:/root/.bash_local.d:ro" \
  -v "$(pwd)/dev/docker-entrypoint.sh:/docker-entrypoint.sh:ro" \
  --entrypoint /docker-entrypoint.sh \
  bash:latest bash

# inside the container
(cd ~ && .dotfiles/bootstrap.sh)
apt-get update && apt-get install -y --no-install-recommends curl git tar
env -i PS1=1 TERM="$TERM" PATH="$PATH" HOME="$HOME" SHELL="$SHELL" bash -l
```
