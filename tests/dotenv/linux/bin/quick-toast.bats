#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/linux/bin/quick-toast"
}

@test "quick-toast: -h and --help print usage" {
  use_mock_bin_path

  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: quick-toast [OPTION]... [SUMMARY] [BODY]"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "quick-toast: rings the terminal bell and exits 1 when notify-send is unavailable" {
  use_mock_bin_path

  run bash "${SCRIPT}"
  assert_failure
  assert_output $'\a'
}

@test "quick-toast: supplies a default message and DISPLAY when notify-send is available" {
  use_mock_bin_path
  stub_env_passthrough_command "notify-send" "DISPLAY"

  run env -u DISPLAY bash "${SCRIPT}"
  assert_success
  assert_line --index 0 "DISPLAY=:0"
  assert_line --index 1 "ALERT FROM TERMINAL"
}

@test "quick-toast: preserves DISPLAY and forwards all notification arguments" {
  use_mock_bin_path
  stub_env_passthrough_command "notify-send" "DISPLAY"

  run env DISPLAY=:99 bash "${SCRIPT}" "Build done" "All checks passed"
  assert_success
  assert_line --index 0 "DISPLAY=:99"
  assert_line --index 1 "Build done"
  assert_line --index 2 "All checks passed"
}
