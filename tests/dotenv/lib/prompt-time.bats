#!/usr/bin/env bats
# Tests for dotenv/lib/prompt-time.sh (time segment caching subsystem).
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
  setup_isolated_home

  export DOTFILES__CONFIG_DIR="${XDG_CONFIG_HOME}/dotfiles"
  mkdir -p "${DOTFILES__CONFIG_DIR}"

  PROMPT_COMMAND=
  __dot_prompt_actions=()

  source "${REPO_ROOT}/dotenv/lib/utils.sh"
  source "${REPO_ROOT}/dotenv/lib/prompt.sh"
}

@test "prompt-time: refresh populates the cached time segment" {
  source "${REPO_ROOT}/dotenv/lib/prompt-time.sh"

  [[ -n "${__dot_ps1_time_segment}" ]]
  [[ "${__dot_ps1_time_segment}" =~ [0-9]{2}:[0-9]{2}:[0-9]{2} ]]
}

@test "prompt-time: cached segment renders prompt escapes inside parameter expansion" {
  source "${REPO_ROOT}/dotenv/lib/prompt-time.sh"

  PS1='${__dot_ps1_time_segment}'

  [[ "${PS1@P}" != *'\['* ]]
}

@test "prompt-time: config refresh honors custom day color settings" {
  export DOT_PS1_COLOR_TIME_DAY='DAY:'
  export DOT_PS1_COLOR_TIME_NIGHT='NIGHT:'
  export DOT_PS1_DAY_START=0
  export DOT_PS1_DAY_END=23

  source "${REPO_ROOT}/dotenv/lib/prompt-time.sh"
  internal::ps1-time-config-refresh
  internal::ps1-time-refresh

  [[ "${__dot_ps1_time_segment}" == DAY:* ]]
}

@test "prompt-time: refresh clears the segment when no prompt uses time" {
  DOT_PS1_SEGMENTS=(user)
  DOT_SUDO_PS1_SEGMENTS=(user)

  source "${REPO_ROOT}/dotenv/lib/prompt-time.sh"

  __dot_ps1_time_segment="stale"
  internal::ps1-time-refresh

  [ -z "${__dot_ps1_time_segment}" ]
}

@test "prompt-time: hooks are registered" {
  source "${REPO_ROOT}/dotenv/lib/prompt-time.sh"

  [[ " ${__dot_prompt_actions[*]} " == *' internal::ps1-time-refresh '* ]]
}
