#!/usr/bin/env bats
# Tests for plugins/30-bat.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "30-bat: falls back to batcat and configures colorized paging" {
  export DOT_SOLARIZED_LIGHT=1
  stub_fixed_output_command batcat ""

  source "${REPO_ROOT}/plugins/30-bat.sh"

  [ "$(alias bat)" = "alias bat='batcat'" ]
  [ "$(alias cat)" = "alias cat='bat --paging=never'" ]
  [ "${BAT_CONFIG_PATH}" = "${DOTFILES__ROOT}/.dotfiles/config/bat/config" ]
  [ "${BAT_THEME}" = "Solarized (light)" ]
  [ "${MANPAGER}" = "sh -c 'col -bx | bat -l man -p'" ]
  [ "${MANROFFOPT}" = "-c" ]
}
