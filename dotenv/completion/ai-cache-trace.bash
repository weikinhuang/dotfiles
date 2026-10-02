# shellcheck shell=bash
# Bash completion for ai-cache-trace.
# SPDX-License-Identifier: MIT
_dot_ai_cache_trace() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"
  case "${prev}" in
    --run | --from | --to | --show-system) return ;;
  esac
  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W '--json --run --diff --from --to --tools --show-system -h --help' -- "${cur}")
  else
    mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
  fi
}
complete -F _dot_ai_cache_trace ai-cache-trace
