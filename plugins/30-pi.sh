# shellcheck shell=bash
# pi coding agent extensions
# SPDX-License-Identifier: MIT

# @see https://pi.dev/
if ! command -v pi &>/dev/null; then
  return
fi

# pi coding agent wrapper with -u <profile> support.
pi() {
  local profile=""
  local -a args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -u)
        if [[ -z "${2:-}" ]]; then
          echo "pi: -u requires a profile name" >&2
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
    profile_dir="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
  else
    profile_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/pi-${profile}"
    if ! mkdir -p "${profile_dir}"; then
      echo "pi: could not create profile directory ${profile_dir}" >&2
      return 1
    fi
  fi

  (
    if [[ -n "${profile}" ]]; then
      export PI_CODING_AGENT_DIR="${profile_dir}"
      export PI_CODING_AGENT_PROFILE_NAME="${profile}"
    fi
    if [[ -f "${profile_dir}/env" ]]; then
      # shellcheck disable=SC1091
      source "${profile_dir}/env"
    fi
    command pi "${args[@]}"
  )
}

_dot_pi() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"
  if [[ "${prev}" == "-u" ]]; then
    local root="${XDG_CONFIG_HOME:-${HOME}/.config}"
    local -a names=()
    local d
    for d in "${root}"/pi-*/; do
      [[ -d "${d}" ]] || continue
      d="${d%/}"
      names+=("${d##*/pi-}")
    done
    mapfile -t COMPREPLY < <(compgen -W "${names[*]}" -- "${cur}")
  fi
}
complete -F _dot_pi -o default pi
