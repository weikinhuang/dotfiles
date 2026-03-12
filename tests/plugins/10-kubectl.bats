#!/usr/bin/env bats

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command kubectl ""
  stub_fixed_output_command kind ""

  __start_kubectl() {
    :
  }
}

@test "10-kubectl: caches completions and wires the kc alias" {
  source "${REPO_ROOT}/plugins/10-kubectl.sh"

  [ "${DOT_TEST_CACHED_COMPLETIONS[0]}" = "kubectl|kubectl completion bash" ]
  [ "${DOT_TEST_CACHED_COMPLETIONS[1]}" = "kind|kind completion bash" ]
  [ "$(alias kc)" = "alias kc='kubectl'" ]
  [[ "$(complete -p kc)" == *"__start_kubectl kc"* ]]
}
