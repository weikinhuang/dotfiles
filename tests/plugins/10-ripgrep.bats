#!/usr/bin/env bats
# Tests for plugins/10-ripgrep.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command rg ""
}

@test "10-ripgrep: points ripgrep at the dotfiles config by default" {
  source "${REPO_ROOT}/plugins/10-ripgrep.sh"

  [ "${RIPGREP_CONFIG_PATH}" = "${DOTFILES__ROOT}/.dotfiles/config/ripgrep/config" ]
}

@test "10-ripgrep: preserves an existing config path" {
  export RIPGREP_CONFIG_PATH="/tmp/custom-rg"

  source "${REPO_ROOT}/plugins/10-ripgrep.sh"

  [ "${RIPGREP_CONFIG_PATH}" = "/tmp/custom-rg" ]
}
