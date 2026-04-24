# shellcheck shell=bash
# Bash completion for ai-tool-usage.
# SPDX-License-Identifier: MIT

_dot_ai_tool_usage() {
  local cur prev tools subcommands flags
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  # First positional: tool name (discovered from config/*/session-usage.ts).
  if [[ ${COMP_CWORD} -eq 1 ]]; then
    local bin_path script_dir root dir
    bin_path="$(command -v ai-tool-usage 2>/dev/null)"
    [[ -z "${bin_path}" ]] && return
    script_dir="$(cd "$(dirname "${bin_path}")" && pwd -P)"
    root="$(cd "${script_dir}/../.." && pwd -P)"
    tools=""
    for dir in "${root}/config/"*/; do
      [[ -x "${dir}session-usage.ts" ]] && tools+=" $(basename "${dir%/}")"
    done
    mapfile -t COMPREPLY < <(compgen -W "${tools} -h --help" -- "${cur}")
    return
  fi

  # Flags that take a value: complete the value when possible, else return.
  case "${prev}" in
    --group-by | -g)
      mapfile -t COMPREPLY < <(compgen -W "day week" -- "${cur}")
      return
      ;;
    --project | -p | --user-dir | -u | --sort | --limit | -n)
      return
      ;;
  esac

  subcommands="list session totals"
  flags="--json --no-color --no-cost --refresh-prices --project --user-dir --sort --limit --group-by --help -p -u -n -g -h"

  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "${flags}" -- "${cur}")
  else
    mapfile -t COMPREPLY < <(compgen -W "${subcommands}" -- "${cur}")
  fi
}
complete -F _dot_ai_tool_usage ai-tool-usage
