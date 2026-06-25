#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/pbpaste.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/pbpaste"
  stub_fixed_output_command "powershell.exe" $'line one\r\nline two\r\n'
}

@test "pbpaste: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: pbpaste"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "pbpaste: normalizes powershell CRLF output to LF" {
  run bash "${SCRIPT}"
  assert_success
  assert_output $'line one\nline two'
}

@test "pbpaste: requests UTF-8 console output encoding from powershell" {
  stub_passthrough_command powershell.exe
  run bash "${SCRIPT}"
  assert_success
  assert_output --partial '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)'
  assert_output --partial 'Get-Clipboard'
}

@test "pbpaste: preserves UTF-8 clipboard content" {
  stub_fixed_output_command powershell.exe $'π· café\r\n'
  run bash "${SCRIPT}"
  assert_success
  assert_output $'π· café'
}
