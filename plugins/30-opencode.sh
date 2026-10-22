# shellcheck shell=bash
# opencode extensions
# SPDX-License-Identifier: MIT

# @see https://opencode.ai/
if ! command -v opencode &>/dev/null; then
  return
fi

# opencode wrapper with -u <profile> support. A named profile isolates config
# (OPENCODE_CONFIG_DIR), data (OPENCODE_DB, which also holds credentials), and
# the background service: opencode v2 routes every command through one shared
# server registered under $XDG_STATE_HOME/opencode on a fixed port, so a
# profile also gets its own XDG_STATE_HOME and a stable per-profile port.
opencode() {
  local profile=""
  local -a args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -u)
        if [[ -z "${2:-}" ]]; then
          echo "opencode: -u requires a profile name" >&2
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
    profile_dir="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-${HOME}/.config}/opencode}"
  else
    profile_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/opencode-${profile}"
    if ! mkdir -p "${profile_dir}"; then
      echo "opencode: could not create profile directory ${profile_dir}" >&2
      return 1
    fi
  fi

  (
    if [[ -n "${profile}" ]]; then
      export OPENCODE_CONFIG_DIR="${profile_dir}"
      export OPENCODE_DB="${profile_dir}/opencode.db"
      export OPENCODE_PROFILE_NAME="${profile}"
      export XDG_STATE_HOME="${profile_dir}/state"
      if ! grep -qs '"port"' "${profile_dir}/service.json"; then
        command opencode service set port "$(__dot_opencode_profile_port "${profile}")" >/dev/null || return 1
      fi
    fi
    if [[ -f "${profile_dir}/env" ]]; then
      # shellcheck disable=SC1091
      source "${profile_dir}/env"
    fi
    command opencode "${args[@]}"
  )
}

# Stable background-service port for a named profile, outside the default
# channel port (49374). Override per profile with
# `opencode -u <name> service set port <n>`.
__dot_opencode_profile_port() {
  local sum
  sum="$(printf '%s' "$1" | cksum)"
  printf '%s\n' "$((49400 + ${sum%% *} % 500))"
}

internal::cached-completion opencode "opencode --completions bash"

# Capture the native completer that cached-completion just registered, so
# _dot_opencode can delegate to it for positions other than `-u`.
__dot_opencode_native_completer=""
if __dot_opencode_complete_line="$(complete -p opencode 2>/dev/null)" \
  && [[ "${__dot_opencode_complete_line}" == *" -F "* ]]; then
  __dot_opencode_native_completer="${__dot_opencode_complete_line#* -F }"
  __dot_opencode_native_completer="${__dot_opencode_native_completer%% *}"
fi
unset __dot_opencode_complete_line

_dot_opencode() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"
  if [[ "${prev}" == "-u" ]]; then
    local root="${XDG_CONFIG_HOME:-${HOME}/.config}"
    local -a names=()
    local d
    for d in "${root}"/opencode-*/; do
      [[ -d "${d}" ]] || continue
      d="${d%/}"
      names+=("${d##*/opencode-}")
    done
    mapfile -t COMPREPLY < <(compgen -W "${names[*]}" -- "${cur}")
    return
  fi
  if [[ -n "${__dot_opencode_native_completer}" ]] \
    && declare -F "${__dot_opencode_native_completer}" >/dev/null; then
    "${__dot_opencode_native_completer}"
  fi
}
complete -F _dot_opencode -o default opencode
