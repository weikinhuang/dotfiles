#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/linux/bin/pbcopy"
}

@test "pbcopy: prefers xclip and sets DISPLAY when it is missing" {
  use_mock_bin_path
  stub_env_passthrough_command_with_stdin "xclip" "DISPLAY"

  run /bin/bash -c "unset DISPLAY; printf 'copied text' | /bin/bash '${SCRIPT}'"
  assert_success
  assert_line --index 0 "DISPLAY=:0"
  assert_line --index 1 "-selection"
  assert_line --index 2 "clipboard"
  assert_line --index 3 "copied text"
}

@test "pbcopy: falls back to xsel when xclip is absent" {
  use_mock_bin_path
  stub_env_passthrough_command_with_stdin "xsel" "DISPLAY"

  run /bin/bash -c "unset DISPLAY; printf 'copied text' | /bin/bash '${SCRIPT}'"
  assert_success
  assert_line --index 0 "DISPLAY=:0"
  assert_line --index 1 "-i"
  assert_line --index 2 "--clipboard"
  assert_line --index 3 "copied text"
}

@test "pbcopy: preserves an existing DISPLAY value" {
  use_mock_bin_path
  stub_env_passthrough_command_with_stdin "xclip" "DISPLAY"

  run bash -c "printf 'copied text' | DISPLAY=:99 /bin/bash '${SCRIPT}'"
  assert_success
  assert_line --index 0 "DISPLAY=:99"
  assert_line --index 1 "-selection"
  assert_line --index 2 "clipboard"
  assert_line --index 3 "copied text"
}

@test "pbcopy: exits with an error when no clipboard backend is installed" {
  use_mock_bin_path

  run bash "${SCRIPT}"
  assert_failure
  assert_output "pbcopy: requires xclip or xsel"
}
