#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/pbpaste

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/pbpaste"
  stub_fixed_output_command "powershell.exe" $'line one\r\nline two\r\n'
}

@test "pbpaste: normalizes powershell CRLF output to LF" {
  run bash "${SCRIPT}"
  assert_success
  assert_output $'line one\nline two'
}
