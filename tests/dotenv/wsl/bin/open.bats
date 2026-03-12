#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/open

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/open"
  stub_passthrough_command "winstart"
}

@test "open: delegates all arguments to winstart" {
  run bash "${SCRIPT}" https://example.com "two words"
  assert_success
  assert_line --index 0 "https://example.com"
  assert_line --index 1 "two words"
}
