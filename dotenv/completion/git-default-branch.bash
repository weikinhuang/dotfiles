# shellcheck shell=bash
# Bash completion for git-default-branch.
# SPDX-License-Identifier: MIT

_dot_git_default_branch() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-h --help" -- "${cur}")
  fi
}
complete -F _dot_git_default_branch git-default-branch
