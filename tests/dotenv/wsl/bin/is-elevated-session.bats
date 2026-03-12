#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/is-elevated-session.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/is-elevated-session"
}

@test "is-elevated-session: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: is-elevated-session"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "is-elevated-session: exits successfully when powershell reports True" {
  stub_fixed_output_command "powershell.exe" $'True\r\n'

  run bash "${SCRIPT}"
  assert_success
}

@test "is-elevated-session: exits 1 when powershell reports False" {
  stub_fixed_output_command "powershell.exe" $'False\r\n'

  run bash "${SCRIPT}"
  assert_failure
  [[ "${status}" -eq 1 ]]
}

@test "is-elevated-session: exits 255 when powershell invocation fails" {
  stub_fixed_output_command "powershell.exe" "" 7

  run bash "${SCRIPT}"
  assert_failure
  [[ "${status}" -eq 255 ]]
}
