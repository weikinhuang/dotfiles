# shellcheck shell=bash
# Bash completion for ai-session-inspect.
# SPDX-License-Identifier: MIT
_dot_ai_session_inspect() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"
  case "${prev}" in
    -u | --user-dir)
      mapfile -t COMPREPLY < <(compgen -d -- "${cur}")
      return
      ;;
  esac
  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W '--json --turns --recaps --snapshots --all --no-ids -u --user-dir -h --help' -- "${cur}")
  else
    mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
  fi
}
complete -F _dot_ai_session_inspect ai-session-inspect
