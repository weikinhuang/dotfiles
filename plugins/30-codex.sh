# shellcheck shell=bash
# Codex cli extensions
# SPDX-License-Identifier: MIT

# @see https://developers.openai.com/codex/cli/
if ! command -v codex &>/dev/null; then
  return
fi

# Codex wrapper with -u <profile> support.
codex() {
  local profile=""
  local -a args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -u)
        if [[ -z "${2:-}" ]]; then
          echo "codex: -u requires a profile name" >&2
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
    profile_dir="${CODEX_HOME:-${HOME}/.codex}"
  else
    profile_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/codex-${profile}"
    if ! mkdir -p "${profile_dir}"; then
      echo "codex: could not create profile directory ${profile_dir}" >&2
      return 1
    fi
  fi

  (
    if [[ -n "${profile}" ]]; then
      export CODEX_HOME="${profile_dir}"
    fi
    if [[ -f "${profile_dir}/env" ]]; then
      # shellcheck disable=SC1091
      source "${profile_dir}/env"
    fi
    command codex "${args[@]}"
  )
}

internal::cached-completion codex "codex completion"

# Capture the native completer that cached-completion just registered, so
# _dot_codex can delegate to it for positions other than `-u`.
__dot_codex_native_completer=""
if __dot_codex_complete_line="$(complete -p codex 2>/dev/null)" \
  && [[ "${__dot_codex_complete_line}" == *" -F "* ]]; then
  __dot_codex_native_completer="${__dot_codex_complete_line#* -F }"
  __dot_codex_native_completer="${__dot_codex_native_completer%% *}"
fi
unset __dot_codex_complete_line

_dot_codex() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  if [[ "${prev}" == "-u" ]]; then
    local root="${XDG_CONFIG_HOME:-${HOME}/.config}"
    local -a names=()
    local d
    for d in "${root}"/codex-*/; do
      [[ -d "${d}" ]] || continue
      d="${d%/}"
      names+=("${d##*/codex-}")
    done
    mapfile -t COMPREPLY < <(compgen -W "${names[*]}" -- "${cur}")
    return
  fi
  if [[ -n "${__dot_codex_native_completer}" ]] \
    && declare -F "${__dot_codex_native_completer}" >/dev/null; then
    "${__dot_codex_native_completer}"
  fi
}
complete -F _dot_codex -o default codex
