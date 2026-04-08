#!/usr/bin/env bats
# Tests for dotenv/lib/prompt-git.sh (git prompt caching subsystem).
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
  setup_isolated_home

  export TERM=xterm-256color
  export DOTFILES__CONFIG_DIR="${XDG_CONFIG_HOME}/dotfiles"
  mkdir -p "${DOTFILES__CONFIG_DIR}"

  PROMPT_COMMAND=
  __dot_prompt_actions=()
  chpwd_functions=()
  preexec_functions=()

  source "${REPO_ROOT}/dotenv/lib/utils.sh"
  source "${REPO_ROOT}/dotenv/lib/prompt.sh"

  internal::ps1-proc-use() {
    echo -n "0.42"
  }
}

@test "prompt-git: gitdir resolves a gitdir file while walking upward" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  mkdir -p "${repo}/.realgit" "${repo}/nested/path"
  printf 'gitdir: .realgit\n' >"${repo}/.git"

  source "${REPO_ROOT}/dotenv/lib/prompt-git.sh"
  cd "${repo}/nested/path"

  run internal::ps1-gitdir
  assert_success
  assert_output "${repo}/.realgit"
}

@test "prompt-git: gitdir fails for broken gitdir pointers" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  mkdir -p "${repo}"
  printf 'gitdir: missing-dir\n' >"${repo}/.git"

  source "${REPO_ROOT}/dotenv/lib/prompt-git.sh"
  cd "${repo}"

  run internal::ps1-gitdir
  assert_failure
  assert_output ""
}

@test "prompt-git: preexec-mark-dirty detects git commands but not plain text" {
  source "${REPO_ROOT}/dotenv/lib/prompt-git.sh"

  unset __dot_ps1_git_cache_dirty
  internal::ps1-git-preexec-mark-dirty "sudo git status"
  [ "${__dot_ps1_git_cache_dirty}" = "1" ]

  unset __dot_ps1_git_cache_dirty
  internal::ps1-git-preexec-mark-dirty "echo git status"
  [ -z "${__dot_ps1_git_cache_dirty:-}" ]
}

@test "prompt-git: preexec-mark-dirty detects wrapped git commands" {
  source "${REPO_ROOT}/dotenv/lib/prompt-git.sh"

  unset __dot_ps1_git_cache_dirty
  internal::ps1-git-preexec-mark-dirty "command git status"
  [ "${__dot_ps1_git_cache_dirty}" = "1" ]

  unset __dot_ps1_git_cache_dirty
  internal::ps1-git-preexec-mark-dirty "env /usr/bin/git status"
  [ "${__dot_ps1_git_cache_dirty}" = "1" ]
}

@test "prompt-git: update reuses cache within TTL and refreshes after max age" {
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

  source "${REPO_ROOT}/dotenv/lib/prompt-git.sh"
  : >"${git_ps1_log}"

  TEST_NOW_MS=1000
  internal::ps1-git-now-ms() {
    echo "${TEST_NOW_MS}"
  }

  internal::ps1-git-cache-invalidate
  internal::ps1-git-update
  [ "$(wc -l <"${git_ps1_log}")" -eq 1 ]

  TEST_NOW_MS=1500
  internal::ps1-git-update
  [ "$(wc -l <"${git_ps1_log}")" -eq 1 ]

  TEST_NOW_MS=2501
  internal::ps1-git-update
  [ "$(wc -l <"${git_ps1_log}")" -eq 2 ]
  [[ -n "${__dot_ps1_git_segment}" ]]
}

@test "prompt-git: update clears the segment outside git repos" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  mkdir -p "${repo}/.git"
  : >"${repo}/.git/HEAD"
  cd "${repo}"

  __git_ps1() {
    printf "$1" "main"
  }

  source "${REPO_ROOT}/dotenv/lib/prompt-git.sh"
  internal::ps1-git-cache-invalidate
  internal::ps1-git-update
  [[ -n "${__dot_ps1_git_segment}" ]]

  cd "${BATS_TEST_TMPDIR}"
  internal::ps1-git-update
  [[ -z "${__dot_ps1_git_segment}" ]]
}

@test "prompt-git: update clears stale state when __git_ps1 is unavailable" {
  source "${REPO_ROOT}/dotenv/lib/prompt-git.sh"
  __dot_ps1_git_segment="stale"

  internal::ps1-git-update

  [[ -z "${__dot_ps1_git_segment}" ]]
}

@test "prompt-git: invalidate-on-git can be disabled" {
  export DOT_GIT_PROMPT_INVALIDATE_ON_GIT=0
  source "${REPO_ROOT}/dotenv/lib/prompt-git.sh"

  unset __dot_ps1_git_cache_dirty
  internal::ps1-git-preexec-mark-dirty "git status"
  [ -z "${__dot_ps1_git_cache_dirty:-}" ]
}

@test "prompt-git: hooks are registered" {
  source "${REPO_ROOT}/dotenv/lib/prompt-git.sh"

  [[ " ${preexec_functions[*]} " == *' internal::ps1-git-preexec-mark-dirty '* ]]
  [[ " ${chpwd_functions[*]} " == *' internal::ps1-git-cache-invalidate '* ]]
  [[ " ${__dot_prompt_actions[*]} " == *' internal::ps1-git-update '* ]]
}
