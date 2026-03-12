#!/usr/bin/env bats

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_fixed_output_command npm ""
  stub_fixed_output_command manpath "/usr/share/man\n"
}

@test "30-npm: configures global npm state when nvm is absent" {
  source "${REPO_ROOT}/plugins/30-npm.sh"

  [ "${DOT_TEST_CACHED_COMPLETIONS[0]}" = "npm|npm completion bash" ]
  [ "${NPM_CONFIG_PREFIX}" = "${HOME}/.npm-packages" ]
  [[ ":${PATH}:" == *":${HOME}/.npm-packages/bin:"* ]]
  [ "${MANPATH}" = "/usr/share/man\n:${HOME}/.npm-packages/share/man" ]
  [ "${OPEN_SOURCE_CONTRIBUTOR}" = "true" ]
  [ "${FORCE_COLOR}" = "3" ]
}

@test "30-npm: leaves npm prefix alone when nvm is already loaded" {
  nvm() {
    :
  }

  source "${REPO_ROOT}/plugins/30-npm.sh"

  [ -z "${NPM_CONFIG_PREFIX+x}" ]
}
