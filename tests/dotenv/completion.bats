#!/usr/bin/env bats
# Tests for dotenv/completion.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  export DOTFILES__ROOT="${BATS_TEST_TMPDIR}/root"
  mkdir -p "${DOTFILES__ROOT}"
  ln -sfn "${REPO_ROOT}" "${DOTFILES__ROOT}/.dotfiles"
  source "${REPO_ROOT}/dotenv/completion.sh"
}

# Drives a registered completion function and prints COMPREPLY one per line.
_run_completion() {
  local cmd="$1"
  shift
  local spec func
  spec="$(complete -p "${cmd}" 2>/dev/null)" || return 1
  if [[ "${spec}" =~ -F[[:space:]]+([^[:space:]]+) ]]; then
    func="${BASH_REMATCH[1]}"
  else
    return 0
  fi
  COMP_WORDS=("${cmd}" "$@")
  COMP_CWORD=$#
  COMP_LINE="${cmd} $*"
  COMP_POINT=${#COMP_LINE}
  COMPREPLY=()
  "${func}" "${cmd}" "${!#}" "${COMP_WORDS[COMP_CWORD-1]}"
  printf '%s\n' "${COMPREPLY[@]}"
}

@test "completion: routes sudo through the command-offset handler" {
  [[ "$(complete -p sudo)" == "complete -F _dot_complete_command_offset sudo" ]]
}

@test "completion: sudo CMD ARGS delegates to CMD's completion" {
  # `sudo genpasswd --` should yield the same flags as `genpasswd --`.
  run _run_completion sudo genpasswd --
  assert_success
  assert_line "--alpha"
  assert_line "--length"
  assert_line "--help"
}

@test "completion: aliases auto-route to the underlying command's completion" {
  alias gp='genpasswd'
  source "${REPO_ROOT}/dotenv/completion.sh"

  [[ "$(complete -p gp)" == "complete -F _dot_complete_alias gp" ]]
  run _run_completion gp --
  assert_success
  assert_line "--alpha"
  assert_line "--length"
}

@test "completion: alias auto-registration ignores aliases with names starting with a dash" {
  # `alias -- -='cd -'` defines an alias literally named `-`; the `complete`
  # builtin can't register a name that starts with a dash, so the auto-loop
  # must skip it instead of erroring out.
  run bash -c "
    export DOTFILES__ROOT='${BATS_TEST_TMPDIR}/root'
    mkdir -p \"\${DOTFILES__ROOT}\"
    ln -sfn '${REPO_ROOT}' \"\${DOTFILES__ROOT}/.dotfiles\"
    alias -- -='cd -'
    source '${REPO_ROOT}/dotenv/completion.sh'
  "
  assert_success
  refute_output --partial "invalid option"
}

@test "completion: alias auto-registration skips aliases that already have a completion" {
  alias mygit='git-sync'
  complete -W "alpha beta" mygit
  source "${REPO_ROOT}/dotenv/completion.sh"

  # Existing custom completion is preserved, not overwritten by the auto-loop.
  [[ "$(complete -p mygit)" == "complete -W 'alpha beta' mygit" ]]
}

@test "completion: per-command completions are loaded for dotenv/bin scripts" {
  complete -p genpasswd >/dev/null
  complete -p clipboard-server >/dev/null
  complete -p git-sync >/dev/null
  complete -p git-ls-dir >/dev/null
  complete -p git-cherry-pick-from >/dev/null
}

@test "completion: genpasswd suggests flags when current word starts with -" {
  run _run_completion genpasswd --
  assert_success
  assert_line "--alpha"
  assert_line "--length"
  assert_line "--chars"
  assert_line "--help"
}

@test "completion: genpasswd suggests nothing as the value of --length" {
  run _run_completion genpasswd --length ''
  assert_success
  assert_output ""
}

@test "completion: clipboard-server suggests subcommand verbs at first positional" {
  run _run_completion clipboard-server ''
  assert_success
  assert_line "start"
  assert_line "stop"
  assert_line "restart"
  assert_line "server"
}

@test "completion: clipboard-server falls back to flag list when current word starts with -" {
  run _run_completion clipboard-server -
  assert_success
  assert_line "--enable-paste"
  assert_line "--socket"
}
