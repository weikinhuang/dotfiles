#!/usr/bin/env bats
# Tests for dotenv/lib/prompt-loadavg.sh (load-average segment caching subsystem).
# shellcheck disable=SC2154  # __dot_ps1_reset set by sourced prompt.sh
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

  internal::ps1-proc-use() {
    echo -n "2.34"
  }
}

@test "prompt-loadavg: refresh populates the cached load-average segment" {
  source "${REPO_ROOT}/dotenv/lib/prompt-loadavg.sh"

  [[ "${__dot_ps1_loadavg_segment}" == *'2.34'* ]]
}

@test "prompt-loadavg: refresh selects the color bucket from the integer part" {
  source "${REPO_ROOT}/dotenv/lib/prompt-loadavg.sh"

  local rendered
  rendered="$(printf '%q' "${__dot_ps1_loadavg_segment}")"

  [[ "${rendered}" == *'38;5;109m'* ]]
}

@test "prompt-loadavg: refresh clamps large load values to the last color bucket" {
  internal::ps1-proc-use() {
    echo -n "99.34"
  }

  source "${REPO_ROOT}/dotenv/lib/prompt-loadavg.sh"
  internal::ps1-loadavg-refresh

  local rendered
  rendered="$(printf '%q' "${__dot_ps1_loadavg_segment}")"

  [[ "${rendered}" == *'38;5;167m'* ]]
}

@test "prompt-loadavg: cached segment renders prompt escapes inside parameter expansion" {
  source "${REPO_ROOT}/dotenv/lib/prompt-loadavg.sh"

  PS1='${__dot_ps1_loadavg_segment}'

  [[ "${PS1@P}" != *'\['* ]]
}

@test "prompt-loadavg: monochrome mode omits color prefixes" {
  export DOT_PS1_MONOCHROME=1

  source "${REPO_ROOT}/dotenv/lib/prompt-loadavg.sh"
  internal::ps1-loadavg-config-refresh
  internal::ps1-loadavg-refresh

  local rendered_reset
  internal::ps1-render-literal "${__dot_ps1_reset}" rendered_reset

  [ "${__dot_ps1_loadavg_segment}" = "2.34${rendered_reset} " ]
}

@test "prompt-loadavg: refresh clears the segment when no prompt uses loadavg" {
  # shellcheck disable=SC2034  # read by sourced prompt-loadavg.sh
  DOT_PS1_SEGMENTS=(user)
  # shellcheck disable=SC2034  # read by sourced prompt-loadavg.sh
  DOT_SUDO_PS1_SEGMENTS=(user)

  source "${REPO_ROOT}/dotenv/lib/prompt-loadavg.sh"

  __dot_ps1_loadavg_segment="stale"
  internal::ps1-loadavg-refresh

  [ -z "${__dot_ps1_loadavg_segment}" ]
}

@test "prompt-loadavg: refresh clears the segment when the proc helper is unavailable" {
  unset -f internal::ps1-proc-use

  source "${REPO_ROOT}/dotenv/lib/prompt-loadavg.sh"

  [ -z "${__dot_ps1_loadavg_segment}" ]
}

@test "prompt-loadavg: refresh tolerates an empty internal color array" {
  source "${REPO_ROOT}/dotenv/lib/prompt-loadavg.sh"

  __dot_ps1_load_colors=()
  internal::ps1-loadavg-refresh

  local rendered_reset
  internal::ps1-render-literal "${__dot_ps1_reset}" rendered_reset

  [ "${__dot_ps1_loadavg_segment}" = "2.34${rendered_reset} " ]
}

@test "prompt-loadavg: hooks are registered" {
  source "${REPO_ROOT}/dotenv/lib/prompt-loadavg.sh"

  [[ " ${__dot_prompt_actions[*]} " == *' internal::ps1-loadavg-refresh '* ]]
}

@test "prompt-loadavg: color array persists when sourced inside a function scope" {
  source_in_function() {
    source "${REPO_ROOT}/dotenv/lib/prompt-loadavg.sh"
  }

  source_in_function

  declare -p __dot_ps1_load_colors &>/dev/null
  internal::ps1-proc-use() {
    echo -n "4"
  }
  internal::ps1-loadavg-refresh

  local rendered
  rendered="$(printf '%q' "${__dot_ps1_loadavg_segment}")"
  [[ "${rendered}" == *'38;5;107m'* ]]
}
