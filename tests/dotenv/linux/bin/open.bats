#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/linux/bin/open"
}

@test "open: prefers xdg-open when it is available" {
  use_mock_bin_path
  stub_named_passthrough_command "xdg-open"
  stub_named_passthrough_command "gnome-open"

  run bash "${SCRIPT}" target.txt
  assert_success
  assert_line --index 0 "xdg-open"
  assert_line --index 1 "target.txt"
}

@test "open: falls back to gnome-open when xdg-open is absent" {
  use_mock_bin_path
  stub_named_passthrough_command "gnome-open"

  run bash "${SCRIPT}" target.txt
  assert_success
  assert_line --index 0 "gnome-open"
  assert_line --index 1 "target.txt"
}

@test "open: falls back to nautilus when no other opener exists" {
  use_mock_bin_path
  stub_named_passthrough_command "nautilus"

  run bash "${SCRIPT}" target.txt
  assert_success
  assert_line --index 0 "nautilus"
  assert_line --index 1 "target.txt"
}

@test "open: exits with a command error when no opener is installed" {
  use_mock_bin_path

  run bash "${SCRIPT}" target.txt
  assert_failure
  [[ "${status}" -eq 127 ]]
}
