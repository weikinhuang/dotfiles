#!/usr/bin/env bats

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command jq ""
}

@test "10-jq: sets the default color palette when unset" {
  source "${REPO_ROOT}/plugins/10-jq.sh"

  [ "${JQ_COLORS}" = "0;90:0;31:0;32:0;33:0;36:1;35:1;35:1;34" ]
}

@test "10-jq: preserves an existing color palette" {
  export JQ_COLORS="custom"

  source "${REPO_ROOT}/plugins/10-jq.sh"

  [ "${JQ_COLORS}" = "custom" ]
}
