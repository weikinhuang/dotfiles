#!/usr/bin/env bats
# Tests for plugins/30-codex.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command codex ""
}

@test "30-codex: registers cached completion" {
  source "${REPO_ROOT}/plugins/30-codex.sh"

  [ "${DOT_TEST_CACHED_COMPLETIONS[0]}" = "codex|codex completion" ]
}
