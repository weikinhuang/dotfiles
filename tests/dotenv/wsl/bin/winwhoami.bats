#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/winwhoami

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/winwhoami"
  stub_fixed_output_command "powershell.exe" $'TestUser\r\n'
}

@test "winwhoami: strips carriage returns from powershell output" {
  run bash "${SCRIPT}"
  assert_success
  assert_output "TestUser"
}

@test "winwhoami: propagates powershell failures" {
  stub_fixed_output_command "powershell.exe" "" 7

  run bash "${SCRIPT}"
  assert_failure
  [[ "${status}" -eq 7 ]]
}
