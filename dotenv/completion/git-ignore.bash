# shellcheck shell=bash
# Bash completion for git-ignore.
# SPDX-License-Identifier: MIT

_dot_git_ignore() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-l --local -g --global -h --help" -- "${cur}")
  fi
}
complete -F _dot_git_ignore git-ignore
