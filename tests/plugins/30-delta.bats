#!/usr/bin/env bats
# Tests for plugins/30-delta.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env

  __dot_hyperlink_scheme=""
}

@test "30-delta: removes stale config when delta is unavailable" {
  printf 'stale\n' >"${DOTFILES__CONFIG_DIR}/git-delta.gitconfig"
  use_mock_bin_path

  source "${REPO_ROOT}/plugins/30-delta.sh"

  [ ! -e "${DOTFILES__CONFIG_DIR}/git-delta.gitconfig" ]
}

@test "30-delta: generates the git include config when delta is present" {
  stub_fixed_output_command delta ""

  source "${REPO_ROOT}/plugins/30-delta.sh"

  grep -F "[core]" "${DOTFILES__CONFIG_DIR}/git-delta.gitconfig"
  grep -F "pager = delta" "${DOTFILES__CONFIG_DIR}/git-delta.gitconfig"
  [ -z "${__dot_delta_syntax_theme+x}" ]
  [ -z "${__dot_delta_minus_style+x}" ]
  [ -z "${__dot_delta_minus_emph_style+x}" ]
  [ -z "${__dot_delta_plus_style+x}" ]
  [ -z "${__dot_delta_plus_emph_style+x}" ]
}

@test "30-delta: uses wsl.localhost format on WSL" {
  stub_fixed_output_command delta ""
  export DOT___IS_WSL=1
  export WSL_DISTRO_NAME="TestDistro"

  source "${REPO_ROOT}/plugins/30-delta.sh"

  grep -F "hyperlinks = true" "${DOTFILES__CONFIG_DIR}/git-delta.gitconfig"
  grep -F "hyperlinks-file-link-format = file://wsl.localhost/TestDistro" "${DOTFILES__CONFIG_DIR}/git-delta.gitconfig"
}

@test "30-delta: enables hyperlinks over SSH when scheme is set" {
  stub_fixed_output_command delta ""
  export DOT___IS_SSH=1
  __dot_hyperlink_scheme="vscode"

  source "${REPO_ROOT}/plugins/30-delta.sh"

  grep -F "hyperlinks = true" "${DOTFILES__CONFIG_DIR}/git-delta.gitconfig"
}

@test "30-delta: disables hyperlinks over SSH without a scheme" {
  stub_fixed_output_command delta ""
  export DOT___IS_SSH=1

  source "${REPO_ROOT}/plugins/30-delta.sh"

  grep -F "hyperlinks = false" "${DOTFILES__CONFIG_DIR}/git-delta.gitconfig"
}

@test "30-delta: disables hyperlinks when DOT_DISABLE_HYPERLINKS is set" {
  stub_fixed_output_command delta ""
  export DOT_DISABLE_HYPERLINKS=1

  source "${REPO_ROOT}/plugins/30-delta.sh"

  grep -F "hyperlinks = false" "${DOTFILES__CONFIG_DIR}/git-delta.gitconfig"
}
