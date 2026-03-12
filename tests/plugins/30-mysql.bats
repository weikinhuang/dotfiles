#!/usr/bin/env bats

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command mysql ""
}

@test "30-mysql: configures the mysql prompt and pager alias" {
  source "${REPO_ROOT}/plugins/30-mysql.sh"

  [[ "${MYSQL_PS1}" == *$'\342\206\222'* ]]
  [[ "$(alias mysql)" == *"--line-numbers"* ]]
  [[ "$(alias mysql)" == *"less -inSFX"* ]]
  [[ "$(alias mysql)" == *"--show-warnings"* ]]
}
