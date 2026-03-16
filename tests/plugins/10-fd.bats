#!/usr/bin/env bats
# Tests for plugins/10-fd.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "10-fd: prefers fd when available and exposes findhere" {
  stub_passthrough_command fd

  source "${REPO_ROOT}/plugins/10-fd.sh"

  [ "${DOTFILES__FD_COMMAND}" = "fd" ]
  run findhere --type f
  assert_success
  assert_line --index 0 "--hidden"
  assert_line --index 1 "--follow"
  assert_line --index 2 "--type"
  assert_line --index 3 "f"
}

@test "10-fd: falls back to fdfind on Debian-style systems" {
  stub_passthrough_command fdfind

  source "${REPO_ROOT}/plugins/10-fd.sh"

  [ "${DOTFILES__FD_COMMAND}" = "fdfind" ]
  [ "$(alias fd)" = "alias fd='fdfind'" ]
  run findhere --type d
  assert_success
  assert_line --index 0 "--hidden"
  assert_line --index 1 "--follow"
  assert_line --index 2 "--type"
  assert_line --index 3 "d"
}
