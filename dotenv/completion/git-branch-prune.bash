# shellcheck shell=bash
# Bash completion for git-branch-prune.
# SPDX-License-Identifier: MIT

_dot_git_branch_prune() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-i --interactive -h --help" -- "${cur}")
  fi
}
complete -F _dot_git_branch_prune git-branch-prune
