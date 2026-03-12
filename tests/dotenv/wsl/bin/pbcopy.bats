#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/pbcopy.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/pbcopy"
  stub_passthrough_command_with_stdin "clip.exe"
}

@test "pbcopy: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: pbcopy"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "pbcopy: forwards arguments and stdin to clip.exe" {
  run bash -c "printf 'copied text' | bash '${SCRIPT}' --html"
  assert_success
  assert_line --index 0 "--html"
  assert_output --partial "copied text"
}
