#!/usr/bin/env bats
# Tests for plugins/10-kubectl.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command kubectl ""
  stub_fixed_output_command kind ""

  __start_kubectl() {
    :
  }
}

@test "10-kubectl: lazy-loads kubectl completion and wires the kc alias" {
  source "${REPO_ROOT}/plugins/10-kubectl.sh"

  [ "${#DOT_TEST_CACHED_COMPLETIONS[@]}" -eq 1 ]
  [ "${DOT_TEST_CACHED_COMPLETIONS[0]}" = "kind|kind completion bash" ]
  [ "$(alias kc)" = "alias kc='kubectl'" ]
  [[ "$(complete -p kc)" == *"internal::kubectl-lazy-complete kc"* ]]

  internal::kubectl-lazy-complete kc

  [ "${DOT_TEST_CACHED_COMPLETIONS[1]}" = "kubectl|kubectl completion bash" ]
  [[ "$(complete -p kc)" == *"__start_kubectl kc"* ]]
}
