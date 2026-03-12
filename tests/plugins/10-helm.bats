#!/usr/bin/env bats
# Tests for plugins/10-helm.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command helm ""
}

@test "10-helm: registers cached completion" {
  source "${REPO_ROOT}/plugins/10-helm.sh"

  [ "${DOT_TEST_CACHED_COMPLETIONS[0]}" = "helm|helm completion bash" ]
}
