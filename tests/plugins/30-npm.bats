#!/usr/bin/env bats
# Tests for plugins/30-npm.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command npm ""
}

@test "30-npm: configures global npm state when nvm is absent" {
  mkdir -p "${HOME}/.npm-packages/share/man"
  unset FORCE_COLOR

  source "${REPO_ROOT}/plugins/30-npm.sh"

  [ "${DOT_TEST_CACHED_COMPLETIONS[0]}" = "npm|npm completion bash" ]
  [ "${NPM_CONFIG_PREFIX}" = "${HOME}/.npm-packages" ]
  [[ ":${PATH}:" == *":${HOME}/.npm-packages/bin:"* ]]
  [ "${MANPATH}" = "${HOME}/.npm-packages/share/man" ]
  [ "${OPEN_SOURCE_CONTRIBUTOR}" = "true" ]
  [ -z "${FORCE_COLOR+x}" ]
}

@test "30-npm: leaves npm prefix alone when nvm is already loaded" {
  nvm() {
    :
  }

  source "${REPO_ROOT}/plugins/30-npm.sh"

  [ -z "${NPM_CONFIG_PREFIX+x}" ]
}
