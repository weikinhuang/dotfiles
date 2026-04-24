# shellcheck shell=bash
# Bash completion for clipboard-server.
# SPDX-License-Identifier: MIT

_dot_clipboard_server() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  case "${prev}" in
    -p | --pidfile | -s | --socket)
      mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
      return
      ;;
  esac

  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-e --enable-paste -n --notify -p --pidfile -s --socket -h --help" -- "${cur}")
    return
  fi

  # First non-flag word is the subcommand.
  local i word
  for ((i = 1; i < COMP_CWORD; i++)); do
    word="${COMP_WORDS[i]}"
    [[ "${word}" == -* ]] && continue
    case "${COMP_WORDS[i-1]}" in
      -p | --pidfile | -s | --socket) continue ;;
    esac
    return
  done
  mapfile -t COMPREPLY < <(compgen -W "start stop restart server" -- "${cur}")
}
complete -F _dot_clipboard_server clipboard-server
