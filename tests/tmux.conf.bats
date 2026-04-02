#!/usr/bin/env bats
# Tests for tmux.conf.
# SPDX-License-Identifier: MIT

setup() {
  load './helpers/common'
  setup_isolated_home

  ln -s "${REPO_ROOT}" "${HOME}/.dotfiles"
  export TMUX_TEST_SOCKET="dotfiles-test-${BATS_TEST_NUMBER}-$$"
}

teardown() {
  env HOME="${HOME}" tmux -L "${TMUX_TEST_SOCKET}" kill-server >/dev/null 2>&1 || true
}

@test "tmux.conf: bootstraps powerline when powerline-config is installed" {
  if ! command -v tmux &>/dev/null || ! command -v powerline-config &>/dev/null; then
    skip "requires tmux and powerline-config"
  fi

  run env HOME="${HOME}" tmux -L "${TMUX_TEST_SOCKET}" -f "${REPO_ROOT}/tmux.conf" new-session -d -s test
  assert_success

  run env HOME="${HOME}" tmux -L "${TMUX_TEST_SOCKET}" show-options -gqv status-interval
  assert_success
  [ "${output}" = "2" ]

  run env HOME="${HOME}" tmux -L "${TMUX_TEST_SOCKET}" show-options -gqv status-right
  assert_success
  [[ "${output}" == *'tmux right'* ]]
}
