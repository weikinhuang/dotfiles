# shellcheck shell=bash
# Bash completion for genpasswd.
# SPDX-License-Identifier: MIT

_dot_genpasswd() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"

  # Flags that take a free-form value: don't suggest anything.
  case "${prev}" in
    -l | --length | --len | -c | --chars | --charlist)
      return
      ;;
  esac

  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-a --alpha -l --length --len -c --chars --charlist -h --help" -- "${cur}")
  fi
}
complete -F _dot_genpasswd genpasswd
