# Testing

Tests are written with [bats-core](https://github.com/bats-core/bats-core) (Bash Automated Testing System)
and use the [bats-support](https://github.com/bats-core/bats-support) and
[bats-assert](https://github.com/bats-core/bats-assert) helper libraries for assertions.

Tests run inside a Docker container to provide a clean, isolated environment free of
host-specific tools (e.g. `sshd`, `cmd.exe`, WSL utilities) that could interfere with
mocked dependencies.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)

## Running Tests

### Full suite (recommended)

```bash
./dev/test-docker.sh
```

### Quiet mode

Only prints failing tests and a summary line — useful for CI and agents:

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
- Use `setup()` to call `load '../../../helpers/common'` (adjust depth to match) and `setup_mock_bin`.
- Use `run` + `assert_success` / `assert_failure` / `assert_output` / `assert_line` for assertions.
- Use `source_without_main` to unit-test internal functions without triggering the script's entrypoint.

### Example

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

### Available Helpers

Defined in `tests/helpers/common.bash`:

| Helper | Description |
| --- | --- |
| `setup_mock_bin` | Creates mock stubs for `wslpath`, `cmd.exe`, and `powershell.exe` in a temp directory prepended to `PATH` |
| `setup_mock_cmd_stdin` | Replaces the `cmd.exe` stub with one that also forwards stdin |
| `source_without_main` | Sources a script without executing its final entrypoint line, allowing individual functions to be called in tests |

### Mock Behavior

| Mock | Behavior |
| --- | --- |
| `wslpath` | `/mnt/x/rest` → `X:\rest`, all others → `C:\path` |
| `cmd.exe` | Prints each argument on its own line |
| `powershell.exe` | Prints each argument on its own line |

## Linting

[shellcheck](https://github.com/koalaman/shellcheck) and [shfmt](https://github.com/mvdan/sh) validate
all shell scripts. Bats files are checked by `shfmt` (with `-ln bats`) but excluded from `shellcheck`
since it does not support the `@test` syntax.

```bash
./dev/lint.sh
```

## Docker Image

The test image (`dev/Dockerfile.test`) is built from `ubuntu:latest` and installs only `bats`,
`bats-support`, and `bats-assert` from apt. The repo is bind-mounted read-only at `/dotfiles`.

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
