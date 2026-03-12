#!/usr/bin/env bats

setup() {
  load '../helpers/common'
  setup_plugin_test_env
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
}
