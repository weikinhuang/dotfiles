# shellcheck shell=bash
# Bash completion for the dotfiles fswatch wrapper (DIRECTORY COMMAND [ARG...]).
# SPDX-License-Identifier: MIT

_dot_fswatch() {
  local cur="${COMP_WORDS[COMP_CWORD]}"

  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-h --help" -- "${cur}")
    return
  fi

  # First positional: directory; subsequent positionals: command + args (PATH lookup).
  local i positional=0
  for ((i = 1; i < COMP_CWORD; i++)); do
    [[ "${COMP_WORDS[i]}" == -* ]] && continue
    ((positional++))
  done

  case "${positional}" in
    0) mapfile -t COMPREPLY < <(compgen -d -- "${cur}") ;;
    1) mapfile -t COMPREPLY < <(compgen -c -- "${cur}") ;;
    *) mapfile -t COMPREPLY < <(compgen -f -- "${cur}") ;;
  esac
}
complete -F _dot_fswatch fswatch
