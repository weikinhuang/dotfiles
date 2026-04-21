# shellcheck shell=bash
# Bash completion for the WSL `winrun` wrapper around cmd.exe /c.
# SPDX-License-Identifier: MIT

_dot_wsl_winrun() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-h --help" -- "${cur}")
    return
  fi
  mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
}
complete -F _dot_wsl_winrun winrun
complete -F _dot_wsl_winrun winstart
complete -F _dot_wsl_winrun winsudo
