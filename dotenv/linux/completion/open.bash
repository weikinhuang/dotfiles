# shellcheck shell=bash
# Bash completion for the Linux `open` wrapper around xdg-open.
# SPDX-License-Identifier: MIT

_dot_linux_open() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-h --help" -- "${cur}")
    return
  fi
  mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
}
complete -F _dot_linux_open open
