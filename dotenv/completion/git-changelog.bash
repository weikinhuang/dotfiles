# shellcheck shell=bash
# Bash completion for git-changelog.
# SPDX-License-Identifier: MIT

_dot_git_changelog() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-l --list -h --help" -- "${cur}")
    return
  fi
  mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
}
complete -F _dot_git_changelog git-changelog
