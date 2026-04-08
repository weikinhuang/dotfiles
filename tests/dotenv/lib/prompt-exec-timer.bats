#!/usr/bin/env bats
# Tests for dotenv/lib/prompt-exec-timer.sh (exec timer subsystem).
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
  setup_isolated_home

  export DOTFILES__CONFIG_DIR="${XDG_CONFIG_HOME}/dotfiles"
  mkdir -p "${DOTFILES__CONFIG_DIR}"

  PROMPT_COMMAND=
  __dot_prompt_actions=()
  preexec_functions=()

  source "${REPO_ROOT}/dotenv/lib/utils.sh"
  source "${REPO_ROOT}/dotenv/lib/prompt.sh"
}

@test "prompt-exec-timer: timer produces sub-millisecond duration" {
  source "${REPO_ROOT}/dotenv/lib/prompt-exec-timer.sh"

  # Start and stop immediately -- the overhead is sub-millisecond
  __dot_ps1_exectimer=0
  internal::ps1-exec-timer-start
  internal::ps1-exec-timer-stop

  [[ -n "${__dot_ps1_execduration}" ]]
  [[ "${__dot_ps1_execduration}" =~ (us|ms) ]]
}

@test "prompt-exec-timer: timer produces millisecond duration" {
  source "${REPO_ROOT}/dotenv/lib/prompt-exec-timer.sh"

  # Simulate a 50ms duration
  __dot_ps1_exectimer=$((${EPOCHREALTIME/./} - 50000))
  internal::ps1-exec-timer-stop

  [[ "${__dot_ps1_execduration}" == *"ms" ]]
}

@test "prompt-exec-timer: timer produces second duration" {
  source "${REPO_ROOT}/dotenv/lib/prompt-exec-timer.sh"

  # Simulate a 5s duration
  __dot_ps1_exectimer=$((${EPOCHREALTIME/./} - 5000000))
  internal::ps1-exec-timer-stop

  [[ "${__dot_ps1_execduration}" == *"s" ]]
  [[ "${__dot_ps1_execduration}" != *"ms" ]]
}

@test "prompt-exec-timer: timer produces minute duration" {
  source "${REPO_ROOT}/dotenv/lib/prompt-exec-timer.sh"

  # Simulate a 2m duration
  __dot_ps1_exectimer=$((${EPOCHREALTIME/./} - 120000000))
  internal::ps1-exec-timer-stop

  [[ "${__dot_ps1_execduration}" == *"m"*"s" ]]
}

@test "prompt-exec-timer: timer produces hour duration" {
  source "${REPO_ROOT}/dotenv/lib/prompt-exec-timer.sh"

  # Simulate a 1h duration
  __dot_ps1_exectimer=$((${EPOCHREALTIME/./} - 3600000000))
  internal::ps1-exec-timer-stop

  [[ "${__dot_ps1_execduration}" == *"h"*"m" ]]
}

@test "prompt-exec-timer: timer stop with no start clears duration" {
  source "${REPO_ROOT}/dotenv/lib/prompt-exec-timer.sh"

  __dot_ps1_exectimer=0
  internal::ps1-exec-timer-stop

  [ -z "${__dot_ps1_execduration}" ]
}

@test "prompt-exec-timer: hooks are registered" {
  source "${REPO_ROOT}/dotenv/lib/prompt-exec-timer.sh"

  [[ " ${preexec_functions[*]} " == *' internal::ps1-exec-timer-start '* ]]
  [[ " ${__dot_prompt_actions[*]} " == *' internal::ps1-exec-timer-stop '* ]]
}

@test "prompt-exec-timer: disabled when no timing source available" {
  unset EPOCHREALTIME
  stub_fixed_output_command "date" "N" 0
  source "${REPO_ROOT}/dotenv/lib/prompt-exec-timer.sh"

  [ "${__dot_ps1_no_exec_timer}" = "1" ]
}
