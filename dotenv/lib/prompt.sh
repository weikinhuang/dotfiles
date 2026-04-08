# shellcheck shell=bash
# Segment registry and color resolver for the prompt subsystem.
# Sourced early by bashrc.sh so users can configure segments in ~/.bash_local.
# SPDX-License-Identifier: MIT

# Default segment lists (only set if the user has not already defined them)
if ! declare -p DOT_PS1_SEGMENTS &>/dev/null; then
  DOT_PS1_SEGMENTS=(exit_status bg_jobs time loadavg user session_host workdir dirinfo git exec_time)
fi
if ! declare -p DOT_SUDO_PS1_SEGMENTS &>/dev/null; then
  DOT_SUDO_PS1_SEGMENTS=(exit_status bg_jobs time user session_host workdir)
fi

# Structural PS1 escapes -- constants, never affected by monochrome mode.
__dot_ps1_bold='\[\e[1m\]'
__dot_ps1_reset='\[\e[0m\]'

# Insert or append a segment to a segment list.
# Usage: internal::ps1-segment-add <name> [--before <ref>|--after <ref>] [--sudo]
function internal::ps1-segment-add() {
  local name="" ref="" position="" target="DOT_PS1_SEGMENTS"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --before)
        position="before"
        ref="$2"
        shift 2
        ;;
      --before=*)
        position="before"
        ref="${1#--before=}"
        shift
        ;;
      --after)
        position="after"
        ref="$2"
        shift 2
        ;;
      --after=*)
        position="after"
        ref="${1#--after=}"
        shift
        ;;
      --sudo)
        target="DOT_SUDO_PS1_SEGMENTS"
        shift
        ;;
      *)
        name="$1"
        shift
        ;;
    esac
  done

  [[ -z "$name" ]] && return 1

  local -a entries=()
  eval "entries=(\"\${${target}[@]}\")"

  # Remove existing entry if present
  local -a filtered=()
  local item
  for item in "${entries[@]}"; do
    [[ "$item" != "$name" ]] && filtered+=("$item")
  done

  if [[ -n "$position" ]] && [[ -n "$ref" ]]; then
    local -a result=()
    local found=0
    for item in "${filtered[@]}"; do
      if [[ "$item" == "$ref" ]]; then
        found=1
        if [[ "$position" == "before" ]]; then
          result+=("$name" "$item")
        else
          result+=("$item" "$name")
        fi
      else
        result+=("$item")
      fi
    done
    if [[ "$found" -eq 0 ]]; then
      result+=("$name")
    fi
    eval "${target}=(\"\${result[@]}\")"
  else
    filtered+=("$name")
    eval "${target}=(\"\${filtered[@]}\")"
  fi
}

# Remove a segment from a segment list.
# Usage: internal::ps1-segment-remove <name> [--sudo]
function internal::ps1-segment-remove() {
  local name="" target="DOT_PS1_SEGMENTS"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --sudo)
        target="DOT_SUDO_PS1_SEGMENTS"
        shift
        ;;
      *)
        name="$1"
        shift
        ;;
    esac
  done

  [[ -z "$name" ]] && return 1

  local -a entries=()
  eval "entries=(\"\${${target}[@]}\")"

  local -a filtered=()
  local item
  for item in "${entries[@]}"; do
    [[ "$item" != "$name" ]] && filtered+=("$item")
  done
  eval "${target}=(\"\${filtered[@]}\")"
}

# Resolve a color variable with a default fallback.
# Returns empty string when DOT_PS1_MONOCHROME is set.
# Usage: internal::ps1-resolve-color <var_name> <default> [<result_var>]
# When <result_var> is given, the value is assigned via printf -v (no subshell).
function internal::ps1-resolve-color() {
  local var_name="$1" default="$2" result_var="${3:-}"
  local value
  if [[ -n "${DOT_PS1_MONOCHROME:-}" ]]; then
    value=""
  elif [[ -n "${!var_name+x}" ]]; then
    value="${!var_name}"
  else
    value="$default"
  fi
  if [[ -n "$result_var" ]]; then
    printf -v "$result_var" '%s' "$value"
  else
    echo "$value"
  fi
}
