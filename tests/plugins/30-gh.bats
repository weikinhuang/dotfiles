#!/usr/bin/env bats
# Tests for plugins/30-gh.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command gh ""
}

@test "30-gh: registers cached completion" {
  source "${REPO_ROOT}/plugins/30-gh.sh"

  [ "${DOT_TEST_CACHED_COMPLETIONS[0]}" = "gh|gh completion -s bash" ]
}
