#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/darwin/bin/quick-toast"
}

@test "quick-toast: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: quick-toast [OPTION]... [TITLE] [BODY]"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "quick-toast: uses the default notification title and body when called without arguments" {
  stub_passthrough_command_with_stdin osascript
  run bash "${SCRIPT}"
  assert_success
  assert_line --index 0 "-"
  assert_line --index 1 "Terminal Notification"
  assert_line --index 2 "ALERT FROM TERMINAL"
  assert_output --partial "display notification (item 2 of argv) with title (item 1 of argv)"
}

@test "quick-toast: forwards a custom title and body to osascript" {
  stub_passthrough_command_with_stdin osascript
  run bash "${SCRIPT}" "Build done" "All checks passed"
  assert_success
  assert_line --index 0 "-"
  assert_line --index 1 "Build done"
  assert_line --index 2 "All checks passed"
}

@test "quick-toast: uses the default title when only a body is provided" {
  stub_passthrough_command_with_stdin osascript
  run bash "${SCRIPT}" "Build done"
  assert_success
  assert_line --index 0 "-"
  assert_line --index 1 "Terminal Notification"
  assert_line --index 2 "Build done"
}
