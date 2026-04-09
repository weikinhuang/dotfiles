#!/usr/bin/env bats
# Tests for plugins/10-ripgrep.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command rg ""

  __dot_hyperlink_scheme=""
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

@test "10-ripgrep: no alias override for default hyperlinks" {
  source "${REPO_ROOT}/plugins/10-ripgrep.sh"

  run alias rg
  assert_failure
}

@test "10-ripgrep: enables hyperlinks over SSH when scheme is set" {
  export DOT___IS_SSH=1
  __dot_hyperlink_scheme="vscode"

  source "${REPO_ROOT}/plugins/10-ripgrep.sh"

  run alias rg
  assert_failure
}

@test "10-ripgrep: disables hyperlinks over SSH without a scheme" {
  export DOT___IS_SSH=1

  source "${REPO_ROOT}/plugins/10-ripgrep.sh"

  [[ "$(alias rg)" == *"--hyperlink-format=none"* ]]
}

@test "10-ripgrep: uses wsl prefix format on WSL" {
  export DOT___IS_WSL=1

  source "${REPO_ROOT}/plugins/10-ripgrep.sh"

  [[ "$(alias rg)" == *'--hyperlink-format=file://{wslprefix}{path}'* ]]
}

@test "10-ripgrep: disables hyperlinks when DOT_DISABLE_HYPERLINKS is set" {
  export DOT_DISABLE_HYPERLINKS=1

  source "${REPO_ROOT}/plugins/10-ripgrep.sh"

  [[ "$(alias rg)" == *"--hyperlink-format=none"* ]]
}
