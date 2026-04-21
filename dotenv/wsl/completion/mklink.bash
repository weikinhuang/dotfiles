# shellcheck shell=bash
# Bash completion for the WSL `mklink` wrapper around Windows mklink.
# SPDX-License-Identifier: MIT

_dot_wsl_mklink() {
  local cur="${COMP_WORDS[COMP_CWORD]}"

  case "${cur}" in
    --*)
      mapfile -t COMPREPLY < <(compgen -W "--symbolic --hard --junction --help" -- "${cur}")
      return
      ;;
    /*)
      mapfile -t COMPREPLY < <(compgen -W "/H /J" -- "${cur}")
      return
      ;;
    -*)
      mapfile -t COMPREPLY < <(compgen -W "-s --symbolic -H --hard -j --junction -h --help" -- "${cur}")
      return
      ;;
  esac

  mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
}
complete -F _dot_wsl_mklink mklink
