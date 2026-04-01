#!/usr/bin/env bats
# Tests for plugins/00-chpwd-hook.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "00-chpwd-hook: initializes once and registers the prompt hook" {
  source "${REPO_ROOT}/plugins/00-chpwd-hook.sh"
  source "${REPO_ROOT}/plugins/00-chpwd-hook.sh"

  # shellcheck disable=SC2154
  [ "${__dot_chpwd_imported}" = "defined" ]
  # shellcheck disable=SC2154
  [ "${#__dot_prompt_actions[@]}" -eq 1 ]
  [ "${__dot_prompt_actions[0]}" = "internal::chpwd-hook" ]
  [ "$(declare -p chpwd_functions)" = "declare -a chpwd_functions=()" ]
}

@test "00-chpwd-hook: runs named and array hooks only when the directory changes" {
  local log=
  local dir_one="${BATS_TEST_TMPDIR}/one"
  local dir_two="${BATS_TEST_TMPDIR}/two"
  mkdir -p "${dir_one}" "${dir_two}"

  chpwd() {
    log="${log:+${log}:}named"
  }
  hook_one() {
    log="${log:+${log}:}one"
    internal::chpwd-hook
  }
  hook_two() {
    log="${log:+${log}:}two"
  }
  chpwd_functions=(hook_one hook_two)

  source "${REPO_ROOT}/plugins/00-chpwd-hook.sh"

  cd "${dir_one}"
  internal::chpwd-hook
  internal::chpwd-hook
  cd "${dir_two}"
  internal::chpwd-hook

  [ "${log}" = "named:one:two:named:one:two" ]
}
