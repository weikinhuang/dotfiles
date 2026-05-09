# shellcheck shell=bash
# Bash completion for ai-skill-eval.
# SPDX-License-Identifier: MIT

_dot_ai_skill_eval() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"

  # Flags that take a free-form value: no suggestion.
  case "${prev}" in
    --driver-cmd | --critic-cmd | --model | --only | --num-workers | --timeout | --iteration | --compare-to | --holdout | --max-iterations)
      return
      ;;
    --skill-root | --workspace)
      mapfile -t COMPREPLY < <(compgen -d -- "${cur}")
      return
      ;;
    --eval-set)
      mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
      return
      ;;
    --driver)
      mapfile -t COMPREPLY < <(compgen -W "pi claude codex" -- "${cur}")
      return
      ;;
  esac

  # Find the subcommand (first non-flag word after the program name).
  local i op=""
  for ((i = 1; i < COMP_CWORD; i++)); do
    local w="${COMP_WORDS[i]}"
    case "${w}" in
      -*) continue ;;
      *)
        op="${w}"
        break
        ;;
    esac
  done

  # No subcommand yet: complete subcommand names and global flags.
  if [[ -z "${op}" ]]; then
    if [[ "${cur}" == -* ]]; then
      mapfile -t COMPREPLY < <(compgen -W "--skill-root --workspace --driver --driver-cmd --model --critic-cmd --only --num-workers --timeout --iteration --compare-to --json -v --verbose -h --help --version" -- "${cur}")
    else
      mapfile -t COMPREPLY < <(compgen -W "list run grade rerun report validate benchmark optimize" -- "${cur}")
    fi
    return
  fi

  # Per-subcommand flag set.
  if [[ "${cur}" == -* ]]; then
    local flags="--skill-root --workspace --driver --driver-cmd --model --critic-cmd --num-workers --timeout --json -v --verbose -h --help"
    case "${op}" in
      run | grade | rerun) flags="${flags} --only --iteration" ;;
      report) flags="${flags} --iteration --compare-to" ;;
      benchmark) flags="${flags} --iteration" ;;
      optimize) flags="${flags} --eval-set --holdout --max-iterations --runs-per-query --trigger-threshold --write" ;;
    esac
    mapfile -t COMPREPLY < <(compgen -W "${flags}" -- "${cur}")
    return
  fi

  # Positional args for list/run/grade/report are skill names.
  # Pull them from `ai-skill-eval list --json` if the command is installed
  # and the current directory has skills to scan; otherwise fall back to
  # file completion so the user can point at a skill path directly.
  case "${op}" in
    run | grade | report | validate | benchmark | optimize)
      local names=""
      if command -v ai-skill-eval >/dev/null 2>&1; then
        names="$(ai-skill-eval list --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ".join(s["name"] for s in d))' 2>/dev/null)"
      fi
      if [[ -n "${names}" ]]; then
        mapfile -t COMPREPLY < <(compgen -W "${names}" -- "${cur}")
      fi
      ;;
    rerun)
      # SKILL:EVAL_ID — too dynamic to complete fully; offer skill name prefixes.
      local names=""
      if command -v ai-skill-eval >/dev/null 2>&1; then
        names="$(ai-skill-eval list --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ".join(s["name"]+":" for s in d))' 2>/dev/null)"
      fi
      if [[ -n "${names}" ]]; then
        mapfile -t COMPREPLY < <(compgen -W "${names}" -- "${cur}")
        compopt -o nospace 2>/dev/null || true
      fi
      ;;
  esac
}
complete -F _dot_ai_skill_eval ai-skill-eval
