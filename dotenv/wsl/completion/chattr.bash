# shellcheck shell=bash
# Bash completion for the WSL `chattr` wrapper around Windows attrib.exe.
# SPDX-License-Identifier: MIT

_dot_wsl_chattr() {
  local cur="${COMP_WORDS[COMP_CWORD]}"

  case "${cur}" in
    +* | -[RASHI])
      mapfile -t COMPREPLY < <(compgen -W "+R -R +A -A +S -S +H -H +I -I" -- "${cur}")
      return
      ;;
    /*)
      mapfile -t COMPREPLY < <(compgen -W "/S /D /L" -- "${cur}")
      return
      ;;
    --*)
      mapfile -t COMPREPLY < <(compgen -W "--all --help" -- "${cur}")
      return
      ;;
  esac

  mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
}
complete -F _dot_wsl_chattr chattr
