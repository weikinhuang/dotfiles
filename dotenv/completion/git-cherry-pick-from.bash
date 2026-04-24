# shellcheck shell=bash
# Bash completion for git-cherry-pick-from.
# Usage: git-cherry-pick-from OTHER_PROJECT_DIR GIT_SHA [-- [PATH...]]
# SPDX-License-Identifier: MIT

_dot_git_cherry_pick_from() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-h --help --" -- "${cur}")
    return
  fi

  # Count the positional words seen so far so we can pick the right completer.
  local i word saw_dashdash=0 positional=0
  for ((i = 1; i < COMP_CWORD; i++)); do
    word="${COMP_WORDS[i]}"
    if [[ "${word}" == "--" ]]; then
      saw_dashdash=1
      continue
    fi
    [[ "${word}" == -* ]] && continue
    ((positional++))
  done

  if ((saw_dashdash)); then
    mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
    return
  fi

  case "${positional}" in
    0)
      mapfile -t COMPREPLY < <(compgen -d -- "${cur}")
      ;;
    1)
      local refs=()
      if [[ -n "${prev}" ]] && [[ -d "${prev}" ]]; then
        mapfile -t refs < <(git -C "${prev}" for-each-ref --format='%(refname:short)' refs/heads/ refs/tags/ 2>/dev/null)
      fi
      mapfile -t COMPREPLY < <(compgen -W "${refs[*]}" -- "${cur}")
      ;;
    *)
      mapfile -t COMPREPLY < <(compgen -W "--" -- "${cur}")
      ;;
  esac
}
complete -F _dot_git_cherry_pick_from git-cherry-pick-from
