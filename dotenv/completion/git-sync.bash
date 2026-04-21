# shellcheck shell=bash
# Bash completion for git-sync.
# SPDX-License-Identifier: MIT

_dot_git_sync() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-v --verbose -h --help" -- "${cur}")
  fi
}
complete -F _dot_git_sync git-sync
