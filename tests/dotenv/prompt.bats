#!/usr/bin/env bats
# Tests for dotenv/prompt.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_test_bin
  setup_isolated_home

  export TERM=xterm-256color
  export DOTFILES__CONFIG_DIR="${XDG_CONFIG_HOME}/dotfiles"
  mkdir -p "${DOTFILES__CONFIG_DIR}"

  PROMPT_COMMAND=
  __prompt_actions=()
  chpwd_functions=()
  preexec_functions=()

  source "${REPO_ROOT}/dotenv/lib/utils.sh"

  __ps1_proc_use() {
    echo -n "0.42"
  }

  is-elevated-session() {
    return 1
  }
}

@test "prompt: DOT_DISABLE_PS1 skips prompt setup and clears the flag" {
  export DOT_DISABLE_PS1=1
  PS1="before"

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [ "${PS1}" = "before" ]
  [ -z "${DOT_DISABLE_PS1+x}" ]
}

@test "prompt: sourcing exports prompt variables and registers prompt hooks" {
  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS1}" == *'['*']'* ]]
  [[ "${SUDO_PS1}" == *'['*']'* ]]
  [ "${PS2}" = $'\342\206\222 ' ]
  [[ " ${preexec_functions[*]} " == *' __ps1_exec_timer_start '* ]]
  [[ " ${chpwd_functions[*]} " == *' __dot_git_ps1_cache_invalidate '* ]]
  [[ " ${__prompt_actions[*]} " == *' __ps1_exec_timer_stop '* ]]
  [[ " ${__prompt_actions[*]} " == *' __ps1_newline_check '* ]]
  [[ " ${__prompt_actions[*]} " == *' __dot_git_ps1_update '* ]]
  [ "${GIT_PS1_SHOWDIRTYSTATE}" = "true" ]
}

@test "prompt: git-prompt-gitdir resolves a gitdir file while walking upward" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  mkdir -p "${repo}/.realgit" "${repo}/nested/path"
  printf 'gitdir: .realgit\n' >"${repo}/.git"

  source "${REPO_ROOT}/dotenv/prompt.sh"
  cd "${repo}/nested/path"

  run __dot_git_prompt_gitdir
  assert_success
  assert_output "${repo}/.realgit"
}

@test "prompt: git-prompt-gitdir fails for broken gitdir pointers" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  mkdir -p "${repo}"
  printf 'gitdir: missing-dir\n' >"${repo}/.git"

  source "${REPO_ROOT}/dotenv/prompt.sh"
  cd "${repo}"

  run __dot_git_prompt_gitdir
  assert_failure
  assert_output ""
}

@test "prompt: git-prompt-preexec-mark-dirty detects git commands but not plain text" {
  source "${REPO_ROOT}/dotenv/prompt.sh"

  unset __dot_git_ps1_cache_dirty
  __dot_git_ps1_preexec_mark_dirty "sudo git status"
  [ "${__dot_git_ps1_cache_dirty}" = "1" ]

  unset __dot_git_ps1_cache_dirty
  __dot_git_ps1_preexec_mark_dirty "echo git status"
  [ -z "${__dot_git_ps1_cache_dirty:-}" ]
}

@test "prompt: git-prompt-preexec-mark-dirty detects wrapped git commands" {
  source "${REPO_ROOT}/dotenv/prompt.sh"

  unset __dot_git_ps1_cache_dirty
  __dot_git_ps1_preexec_mark_dirty "command git status"
  [ "${__dot_git_ps1_cache_dirty}" = "1" ]

  unset __dot_git_ps1_cache_dirty
  __dot_git_ps1_preexec_mark_dirty "env /usr/bin/git status"
  [ "${__dot_git_ps1_cache_dirty}" = "1" ]
}

@test "prompt: git-prompt-update reuses cache within TTL and refreshes after max age" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  mkdir -p "${repo}/.git/refs"
  : >"${repo}/.git/HEAD"
  : >"${repo}/.git/index"
  : >"${repo}/.git/refs/stash"
  cd "${repo}"

  local git_ps1_log="${BATS_TEST_TMPDIR}/git-ps1.log"
  : >"${git_ps1_log}"
  __git_ps1() {
    echo called >>"${git_ps1_log}"
    printf "$1" "main"
  }

  export DOT_GIT_PROMPT_CACHE_TTL_MS=1000
  export DOT_GIT_PROMPT_CACHE_MAX_AGE_MS=0

  source "${REPO_ROOT}/dotenv/prompt.sh"
  : >"${git_ps1_log}"

  TEST_NOW_MS=1000
  __dot_git_prompt_now_ms() {
    echo "${TEST_NOW_MS}"
  }

  __dot_git_ps1_cache_invalidate
  __dot_git_ps1_update
  [ "$(wc -l <"${git_ps1_log}")" -eq 1 ]

  TEST_NOW_MS=1500
  __dot_git_ps1_update
  [ "$(wc -l <"${git_ps1_log}")" -eq 1 ]

  TEST_NOW_MS=2501
  __dot_git_ps1_update
  [ "$(wc -l <"${git_ps1_log}")" -eq 2 ]
  [[ -n "${__ps1_var_git_segment}" ]]
}

@test "prompt: git-prompt-update clears the segment outside git repos" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  mkdir -p "${repo}/.git"
  : >"${repo}/.git/HEAD"
  cd "${repo}"

  __git_ps1() {
    printf "$1" "main"
  }

  source "${REPO_ROOT}/dotenv/prompt.sh"
  __dot_git_ps1_cache_invalidate
  __dot_git_ps1_update
  [[ -n "${__ps1_var_git_segment}" ]]

  cd "${BATS_TEST_TMPDIR}"
  __dot_git_ps1_update
  [[ -z "${__ps1_var_git_segment}" ]]
}

@test "prompt: git-prompt-update clears stale state when __git_ps1 is unavailable" {
  source "${REPO_ROOT}/dotenv/prompt.sh"
  __ps1_var_git_segment="stale"

  __dot_git_ps1_update

  [[ -z "${__ps1_var_git_segment}" ]]
}

@test "prompt: WSL elevated sessions use the Windows privileged prompt symbol" {
  export DOT___IS_WSL=1
  stub_passthrough_command "powershell.exe"

  is-elevated-session() {
    return 0
  }

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS1}" == *'W*'* ]]
  [[ "${SUDO_PS1}" == *'W*'* ]]
}
