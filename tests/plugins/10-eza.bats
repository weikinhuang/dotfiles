#!/usr/bin/env bats
# Tests for plugins/10-eza.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "10-eza: installs the theme symlink and publishes ls aliases through the post hook" {
  export DOT_SOLARIZED_DARK=1
  stub_fixed_output_command eza ""

  source "${REPO_ROOT}/plugins/10-eza.sh"

  [ "$(readlink "${HOME}/.config/eza/theme.yml")" = "${DOTFILES__ROOT}/.dotfiles/config/eza/solarized-dark.yml" ]
  # shellcheck disable=SC2154
  [ "${dotfiles_hook_plugin_post_functions[0]}" = "__eza_ls_aliases" ]

  __eza_ls_aliases

  [ "$(alias ls)" = "alias ls='eza'" ]
  [ "$(alias la)" = "alias la='eza -la --group-directories-first'" ]
  [ "$(alias ll)" = "alias ll='eza -l --group-directories-first'" ]
  [ "$(alias l.)" = "alias l.='eza -d .*'" ]
  [ "$(alias lt)" = "alias lt='eza -lT --level=2'" ]
  [ -z "$(type -t __eza_ls_aliases || true)" ]
}
