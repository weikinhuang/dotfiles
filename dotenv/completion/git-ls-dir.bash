# shellcheck shell=bash
# Bash completion for git-ls-dir.
# SPDX-License-Identifier: MIT

_dot_git_ls_dir() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  case "${prev}" in
    -c | --commitish)
      local refs=()
      mapfile -t refs < <(git for-each-ref --format='%(refname:short)' refs/heads/ refs/tags/ refs/remotes/ 2>/dev/null)
      mapfile -t COMPREPLY < <(compgen -W "${refs[*]}" -- "${cur}")
      return
      ;;
  esac

  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-c --commitish -h --help" -- "${cur}")
    return
  fi

  mapfile -t COMPREPLY < <(compgen -f -- "${cur}")
}
complete -F _dot_git_ls_dir git-ls-dir
