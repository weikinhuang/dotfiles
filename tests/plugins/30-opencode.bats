#!/usr/bin/env bats
# Tests for plugins/30-opencode.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command opencode ""
}

@test "30-opencode: registers cached completion" {
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  [ "${DOT_TEST_CACHED_COMPLETIONS[0]}" = "opencode|opencode completion" ]
}
