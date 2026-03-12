#!/usr/bin/env bats
# Tests for plugins/30-difftastic.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "30-difftastic: removes stale config when difftastic is unavailable" {
  printf 'stale\n' >"${DOTFILES__CONFIG_DIR}/git-difftastic.gitconfig"
  use_mock_bin_path

  source "${REPO_ROOT}/plugins/30-difftastic.sh"

  [ ! -e "${DOTFILES__CONFIG_DIR}/git-difftastic.gitconfig" ]
}

@test "30-difftastic: exports defaults and generates git config when difft is present" {
  export DOT_SOLARIZED_LIGHT=1
  stub_fixed_output_command difft ""

  source "${REPO_ROOT}/plugins/30-difftastic.sh"

  [ "${DFT_BACKGROUND}" = "light" ]
  [ "${DFT_DISPLAY}" = "side-by-side" ]
  [ "${DFT_TAB_WIDTH}" = "4" ]
  [ "${DFT_PARSE_ERROR_LIMIT}" = "3" ]
  grep -F 'tool = difftastic' "${DOTFILES__CONFIG_DIR}/git-difftastic.gitconfig"
}
