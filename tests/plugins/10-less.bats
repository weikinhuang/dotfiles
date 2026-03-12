#!/usr/bin/env bats
# Tests for plugins/10-less.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "10-less: exports the default pager configuration and aliases less" {
  stub_fixed_output_command tput ""

  source "${REPO_ROOT}/plugins/10-less.sh"

  [ "${MANPAGER}" = "less -iFXRS -x4" ]
  [ "${LESS}" = "-iFRX" ]
  # shellcheck disable=SC2154
  [ "${LESS_TERMCAP_md}" = $'\e[1;32m' ]
  # shellcheck disable=SC2154
  [ "${LESS_TERMCAP_so}" = $'\e[01;33m' ]
  [ "$(alias less)" = "alias less='less -FRX'" ]
}

@test "10-less: preserves an existing LESS value" {
  export LESS="--custom"
  stub_fixed_output_command tput ""

  source "${REPO_ROOT}/plugins/10-less.sh"

  [ "${LESS}" = "--custom" ]
}
