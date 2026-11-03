#!/usr/bin/env bats
# Tests for plugins/30-pnpm.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  use_mock_bin_path
}

@test "30-pnpm: registers cached completion when pnpm is available" {
  stub_fixed_output_command pnpm ""

  source "${REPO_ROOT}/plugins/30-pnpm.sh"

  run printf '%s\n' "${DOT_TEST_CACHED_COMPLETIONS[@]}"
  assert_success
  assert_output "pnpm|pnpm completion bash"
}

@test "30-pnpm: skips completion when pnpm is absent" {
  source "${REPO_ROOT}/plugins/30-pnpm.sh" || true

  run printf '%s' "${DOT_TEST_CACHED_COMPLETIONS[@]}"
  assert_success
  assert_output ""
}
