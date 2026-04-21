# shellcheck shell=bash
# Bash completion for git-diff-highlight (stdin filter).
# SPDX-License-Identifier: MIT

_dot_git_diff_highlight() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-h --help" -- "${cur}")
  fi
}
complete -F _dot_git_diff_highlight git-diff-highlight
