#!/usr/bin/env bats
# Tests for dotenv/linux/bin/pbpaste.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/linux/bin/pbpaste"
}

@test "pbpaste: -h and --help print usage" {
  use_mock_bin_path

  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: pbpaste"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "pbpaste: prefers xclip and sets DISPLAY when it is missing" {
  use_mock_bin_path
  stub_env_passthrough_command "xclip" "DISPLAY"

  run /bin/bash -c "unset DISPLAY; /bin/bash '${SCRIPT}'"
  assert_success
  assert_line --index 0 "DISPLAY=:0"
  assert_line --index 1 "-selection"
  assert_line --index 2 "clipboard"
  assert_line --index 3 "-o"
}

@test "pbpaste: falls back to xsel when xclip is absent" {
  use_mock_bin_path
  stub_env_passthrough_command "xsel" "DISPLAY"

  run /bin/bash -c "unset DISPLAY; /bin/bash '${SCRIPT}'"
  assert_success
  assert_line --index 0 "DISPLAY=:0"
  assert_line --index 1 "-o"
  assert_line --index 2 "--clipboard"
}

@test "pbpaste: preserves an existing DISPLAY value" {
  use_mock_bin_path
  stub_env_passthrough_command "xclip" "DISPLAY"

  run env DISPLAY=:99 /bin/bash "${SCRIPT}"
  assert_success
  assert_line --index 0 "DISPLAY=:99"
  assert_line --index 1 "-selection"
  assert_line --index 2 "clipboard"
  assert_line --index 3 "-o"
}

@test "pbpaste: exits with an error when no clipboard backend is installed" {
  use_mock_bin_path

  run bash "${SCRIPT}"
  assert_failure
  assert_output "pbpaste: requires xclip or xsel"
}
