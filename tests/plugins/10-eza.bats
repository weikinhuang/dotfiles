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
  [ "${dotfiles_hook_plugin_post_functions[0]}" = "internal::eza-ls-aliases" ]

  internal::eza-ls-aliases

  [ "$(alias ls)" = "alias ls='eza --hyperlink'" ]
  [ "$(alias la)" = "alias la='eza -la --group-directories-first --hyperlink'" ]
  [ "$(alias ll)" = "alias ll='eza -l --group-directories-first --hyperlink'" ]
  [ "$(alias l.)" = "alias l.='eza -d --hyperlink .*'" ]
  [ "$(alias lt)" = "alias lt='eza -lT --level=2 --hyperlink'" ]
  [ -z "$(type -t internal::eza-ls-aliases || true)" ]
}

@test "10-eza: suppresses --hyperlink on WSL where eza omits the hostname" {
  stub_fixed_output_command eza ""
  export DOT___IS_WSL=1

  source "${REPO_ROOT}/plugins/10-eza.sh"
  internal::eza-ls-aliases

  [ "$(alias ls)" = "alias ls='eza'" ]
  [ "$(alias la)" = "alias la='eza -la --group-directories-first'" ]
}
