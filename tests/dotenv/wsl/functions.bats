#!/usr/bin/env bats
# Tests for dotenv/wsl/functions.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
}

@test "wsl/functions: cmd0 strips carriage returns from cmd.exe output" {
  stub_command "cmd.exe" <<'EOF'
#!/usr/bin/env bash
printf 'hello\r\n'
EOF

  source "${REPO_ROOT}/dotenv/wsl/functions.sh"

  run cmd0 echo hello
  assert_success
  assert_output "hello"
}

@test "wsl/functions: cmd0 returns the cmd.exe exit status" {
  stub_command "cmd.exe" <<'EOF'
#!/usr/bin/env bash
printf 'failed\r\n'
exit 7
EOF

  source "${REPO_ROOT}/dotenv/wsl/functions.sh"

  run cmd0 nope
  assert_failure
  [[ "${status}" -eq 7 ]]
  assert_output "failed"
}

@test "wsl/functions: osc8-wsl-rewrite sed rewrites file:// URLs with empty hostname" {
  export WSL_DISTRO_NAME="TestDistro"
  source "${REPO_ROOT}/dotenv/wsl/functions.sh"

  local result
  result=$(printf '\033]8;;file:///tmp/test\033\\hello\033]8;;\033\\\n' \
    | command sed "s,\x1b]8;;file://[^/]*/,\x1b]8;;file://wsl.localhost/${WSL_DISTRO_NAME}/,g")
  [[ "${result}" == *"file://wsl.localhost/TestDistro/tmp/test"* ]]
}

@test "wsl/functions: osc8-wsl-rewrite sed rewrites file:// URLs with a hostname" {
  export WSL_DISTRO_NAME="TestDistro"
  source "${REPO_ROOT}/dotenv/wsl/functions.sh"

  local result
  result=$(printf '\033]8;;file://myhost/tmp/test\033\\hello\033]8;;\033\\\n' \
    | command sed "s,\x1b]8;;file://[^/]*/,\x1b]8;;file://wsl.localhost/${WSL_DISTRO_NAME}/,g")
  [[ "${result}" == *"file://wsl.localhost/TestDistro/tmp/test"* ]]
}

@test "wsl/functions: osc8-wsl-rewrite passes through when stdout is not a tty" {
  export WSL_DISTRO_NAME="TestDistro"

  stub_command "osc8test" <<'STUB'
#!/usr/bin/env bash
echo "plain output"
STUB

  source "${REPO_ROOT}/dotenv/wsl/functions.sh"

  run internal::osc8-wsl-rewrite osc8test
  assert_success
  assert_output "plain output"
}

@test "wsl/functions: osc8-wsl-rewrite strips --hyperlink flags when piped" {
  export WSL_DISTRO_NAME="TestDistro"

  stub_command "argecho" <<'STUB'
#!/usr/bin/env bash
echo "$*"
STUB

  source "${REPO_ROOT}/dotenv/wsl/functions.sh"

  run internal::osc8-wsl-rewrite argecho --color=auto --hyperlink=always -la /tmp
  assert_success
  assert_output "--color=auto -la /tmp"
}

@test "wsl/functions: osc8-wsl-rewrite strips boolean --hyperlink flag when piped" {
  export WSL_DISTRO_NAME="TestDistro"

  stub_command "argecho" <<'STUB'
#!/usr/bin/env bash
echo "$*"
STUB

  source "${REPO_ROOT}/dotenv/wsl/functions.sh"

  run internal::osc8-wsl-rewrite argecho --hyperlink -la /tmp
  assert_success
  assert_output "-la /tmp"
}

@test "wsl/functions: osc8-wsl-rewrite preserves exit status in passthrough" {
  export WSL_DISTRO_NAME="TestDistro"

  stub_command "failcmd" <<'STUB'
#!/usr/bin/env bash
exit 42
STUB

  source "${REPO_ROOT}/dotenv/wsl/functions.sh"

  run internal::osc8-wsl-rewrite failcmd
  [[ "${status}" -eq 42 ]]
}
