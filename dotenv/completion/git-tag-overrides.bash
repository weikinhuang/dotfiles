# shellcheck shell=bash
# Bash completion for git-tag-overrides.
# SPDX-License-Identifier: MIT

_dot_git_tag_overrides() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"

  case "${prev}" in
    -r | --remote)
      mapfile -t COMPREPLY < <(compgen -W "$(git remote 2>/dev/null)" -- "${cur}")
      return
      ;;
  esac

  if [[ "${cur}" == --remote=* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "$(git remote 2>/dev/null)" -- "${cur#--remote=}")
    return
  fi

  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-r --remote -h --help --" -- "${cur}")
    return
  fi

  mapfile -t COMPREPLY < <(compgen -W "$(git tag 2>/dev/null)" -- "${cur}")
}
complete -F _dot_git_tag_overrides git-tag-overrides
