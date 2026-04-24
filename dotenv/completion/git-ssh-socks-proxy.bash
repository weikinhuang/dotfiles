# shellcheck shell=bash
# Bash completion for git-ssh-socks-proxy.
# Defers most completion to the user's ssh completion (hosts come from ~/.ssh/config etc.)
# SPDX-License-Identifier: MIT

_dot_git_ssh_socks_proxy() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  case "${prev}" in
    -p | --port)
      return
      ;;
  esac

  if [[ "${cur}" == -* ]]; then
    mapfile -t COMPREPLY < <(compgen -W "-p --port -h --help" -- "${cur}")
    return
  fi

  # Reuse the ssh completion if one is registered (provides host completion).
  local ssh_complete
  ssh_complete="$(complete -p ssh 2>/dev/null)"
  if [[ "${ssh_complete}" =~ -W[[:space:]]+\"([^\"]*)\" ]]; then
    mapfile -t COMPREPLY < <(compgen -W "${BASH_REMATCH[1]}" -- "${cur}")
  fi
}
complete -F _dot_git_ssh_socks_proxy git-ssh-socks-proxy
