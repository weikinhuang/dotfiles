# shellcheck shell=bash
# GitHub Copilot CLI extensions
# SPDX-License-Identifier: MIT

# @see https://docs.github.com/copilot/how-tos/copilot-cli
if ! command -v copilot &>/dev/null; then
  return
fi

# Copilot wrapper with -u <profile> support. A named profile isolates config,
# sessions, logs, saved approvals, and the selected account (COPILOT_HOME);
# the Keychain token is keyed by GitHub login, so profiles on the same login
# share it. Copilot has no user-level permission rules file, so the wrapper
# turns <profile dir>/tool-permissions into --allow-tool / --deny-tool flags
# and always adds --disable-client-telemetry.
copilot() {
  local profile=""
  local -a args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -u)
        if [[ -z "${2:-}" ]]; then
          echo "copilot: -u requires a profile name" >&2
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
    profile_dir="${COPILOT_HOME:-${HOME}/.copilot}"
  else
    profile_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/copilot-${profile}"
    if ! mkdir -p "${profile_dir}"; then
      echo "copilot: could not create profile directory ${profile_dir}" >&2
      return 1
    fi
  fi

  (
    if [[ -n "${profile}" ]]; then
      export COPILOT_HOME="${profile_dir}"
      export COPILOT_PROFILE_NAME="${profile}"
    fi
    # Copilot only discovers ~/.agents/skills when COPILOT_HOME is ~/.copilot.
    if [[ "${profile_dir}" != "${HOME}/.copilot" && -d "${HOME}/.agents/skills" ]]; then
      export COPILOT_SKILLS_DIRS="${HOME}/.agents/skills${COPILOT_SKILLS_DIRS:+,${COPILOT_SKILLS_DIRS}}"
    fi
    if [[ -f "${profile_dir}/env" ]]; then
      # shellcheck disable=SC1091
      source "${profile_dir}/env"
    fi
    __dot_copilot_permission_flags "${profile_dir}/tool-permissions" || return 1
    command copilot --disable-client-telemetry "${__dot_copilot_flags[@]}" "${args[@]}"
  )
}

# Set __dot_copilot_flags to one --allow-tool= / --deny-tool= flag per
# `allow <pattern>` / `deny <pattern>` line of the rules file $1. Blank lines
# and `#` comments are ignored; any other line is an error so a typo cannot
# silently drop a deny rule. A missing file yields no flags. Called from the
# wrapper's subshell, so the global array does not leak into the caller.
__dot_copilot_permission_flags() {
  local file="$1"
  __dot_copilot_flags=()
  [[ -f "${file}" ]] || return 0
  local line verb pattern lineno=0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    lineno=$((lineno + 1))
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    verb="${line%%[[:space:]]*}"
    pattern="${line#"${verb}"}"
    pattern="${pattern#"${pattern%%[![:space:]]*}"}"
    if [[ -z "${pattern}" ]]; then
      echo "copilot: ${file}:${lineno}: missing pattern after '${verb}'" >&2
      return 1
    fi
    case "${verb}" in
      allow) __dot_copilot_flags+=("--allow-tool=${pattern}") ;;
      deny) __dot_copilot_flags+=("--deny-tool=${pattern}") ;;
      *)
        echo "copilot: ${file}:${lineno}: expected 'allow' or 'deny', got '${verb}'" >&2
        return 1
        ;;
    esac
  done <"${file}"
}

internal::cached-completion copilot "copilot completion bash"

# Capture the native completer that cached-completion just registered, so
# _dot_copilot can delegate to it for positions other than `-u`.
__dot_copilot_native_completer=""
if __dot_copilot_complete_line="$(complete -p copilot 2>/dev/null)" \
  && [[ "${__dot_copilot_complete_line}" == *" -F "* ]]; then
  __dot_copilot_native_completer="${__dot_copilot_complete_line#* -F }"
  __dot_copilot_native_completer="${__dot_copilot_native_completer%% *}"
fi
unset __dot_copilot_complete_line

_dot_copilot() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"
  if [[ "${prev}" == "-u" ]]; then
    local root="${XDG_CONFIG_HOME:-${HOME}/.config}"
    local -a names=()
    local d
    for d in "${root}"/copilot-*/; do
      [[ -d "${d}" ]] || continue
      d="${d%/}"
      names+=("${d##*/copilot-}")
    done
    mapfile -t COMPREPLY < <(compgen -W "${names[*]}" -- "${cur}")
    return
  fi
  if [[ -n "${__dot_copilot_native_completer}" ]] \
    && declare -F "${__dot_copilot_native_completer}" >/dev/null; then
    "${__dot_copilot_native_completer}"
  fi
}
complete -F _dot_copilot -o default copilot
