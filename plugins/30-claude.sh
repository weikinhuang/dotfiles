# shellcheck shell=bash
# Claude Code extensions
# SPDX-License-Identifier: MIT

# @see https://code.claude.com/
if ! command -v claude &>/dev/null; then
  return
fi

# Claude Code wrapper with -u <profile> support.
claude() {
  local profile=""
  local -a args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -u)
        if [[ -z "${2:-}" ]]; then
          echo "claude: -u requires a profile name" >&2
          return 1
        fi
        profile="$2"
        shift 2
        ;;
      -u=*)
        profile="${1#-u=}"
        shift
        ;;
      *)
        args+=("$1")
        shift
        ;;
    esac
  done

  local profile_dir
  if [[ -z "${profile}" ]]; then
    profile_dir="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
  else
    profile_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/claude-${profile}"
    if ! mkdir -p "${profile_dir}"; then
      echo "claude: could not create profile directory ${profile_dir}" >&2
      return 1
    fi
  fi

  (
    if [[ -n "${profile}" ]]; then
      export CLAUDE_CONFIG_DIR="${profile_dir}"
      export CLAUDE_CODE_PROFILE_NAME="${profile}"
    fi
    if [[ -f "${profile_dir}/env" ]]; then
      # shellcheck disable=SC1091
      source "${profile_dir}/env"
    fi
    command claude "${args[@]}"
  )
}

_dot_claude() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  if [[ "${prev}" == "-u" ]]; then
    local root="${XDG_CONFIG_HOME:-${HOME}/.config}"
    local -a names=()
    local d
    for d in "${root}"/claude-*/; do
      [[ -d "${d}" ]] || continue
      d="${d%/}"
      names+=("${d##*/claude-}")
    done
    mapfile -t COMPREPLY < <(compgen -W "${names[*]}" -- "${cur}")
  fi
}
complete -F _dot_claude -o default claude
