# bash completion for ai-cost-doctor
# SPDX-License-Identifier: MIT

_dot_ai_cost_doctor() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"

  case "${prev}" in
    --harness)
      mapfile -t COMPREPLY < <(compgen -W "pi claude codex opencode" -- "${cur}")
      return
      ;;
    --user-dir)
      mapfile -t COMPREPLY < <(compgen -d -- "${cur}")
      return
      ;;
  esac

  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W \
      "--harness --user-dir --json --turns --no-color --no-cost --refresh-prices -h --help" -- "${cur}")
    return
  fi

  # First non-flag word is the harness; afterwards complete a session path.
  local saw_harness="" w
  for w in "${COMP_WORDS[@]:1:COMP_CWORD-1}"; do
    case "${w}" in
      pi | claude | codex | opencode) saw_harness=1 ;;
    esac
  done

  if [[ -z "${saw_harness}" ]]; then
    mapfile -t COMPREPLY < <(compgen -W "pi claude codex opencode" -- "${cur}")
    # Also allow a bare file path in the first position (auto-detect mode).
    mapfile -O "${#COMPREPLY[@]}" -t COMPREPLY < <(compgen -f -- "${cur}")
    return
  fi

  # Otherwise complete a session-log file path (an id/prefix is freeform text).
  mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
}

complete -F _dot_ai_cost_doctor ai-cost-doctor
