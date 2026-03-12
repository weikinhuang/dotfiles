#!/usr/bin/env bats
# Tests for plugins/30-git.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command git ""
}

@test "30-git: sources git-prompt helpers when __git_ps1 is missing" {
  source "${REPO_ROOT}/plugins/30-git.sh"

  [ "$(type -t __git_ps1)" = "function" ]
}

@test "30-git: preserves an existing __git_ps1 implementation" {
  __git_ps1() {
    printf 'custom-ps1\n'
  }

  source "${REPO_ROOT}/plugins/30-git.sh"

  [ "$(__git_ps1 '%s')" = "custom-ps1" ]
}
