# shellcheck shell=bash
# Bash completion for git-undo-index.
# SPDX-License-Identifier: MIT

_dot_git_undo_index() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-h --help" -- "${cur}")
    return
  fi
  mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
}
complete -F _dot_git_undo_index git-undo-index
