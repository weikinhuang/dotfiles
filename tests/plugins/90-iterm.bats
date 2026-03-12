#!/usr/bin/env bats

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "90-iterm: skips registration outside supported iTerm sessions" {
  export DOTENV=linux
  export ITERM_SESSION_ID=session-1

  source "${REPO_ROOT}/plugins/90-iterm.sh"

  # shellcheck disable=SC2154
  [ "${#dotfiles_complete_functions[@]}" -eq 0 ]
}
