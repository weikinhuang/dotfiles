# shellcheck shell=bash
# Dotfiles meta-commands: update the repo, profile startup, profile the prompt.
# SPDX-License-Identifier: MIT

# update the dotfiles repo
function dotfiles-update() (
  # shellcheck disable=SC2164
  cd "${DOTFILES__ROOT}/.dotfiles"
  git pull origin master
  ./bootstrap.sh
)

# Summarize traced shell operations and print top slowest entries.
function internal::trace-top-ops() {
  local trace_file="$1"
  local title="$2"
  local include_re="${3:-}"
  local exclude_re="${4:-}"
  local trace_output

  echo "${title}"
  trace_output="$(LC_ALL=C awk -F'\t' -v home="$HOME" -v include_re="$include_re" -v exclude_re="$exclude_re" '/^\++ [0-9]+\./ {
    gsub(/^\++ /, "", $1)
    n = split($1, parts, " ")
    ts = parts[1]
    src = (n > 1) ? parts[2] : ""
    gsub(home, "~", src)
    cmd = $2
    sub(/^ +/, "", cmd)
    gsub(home, "~", cmd)
    gsub(/=[^ ]{60,}/, "=<...>", cmd)
    noise = (cmd ~ /^\[?\[/ || cmd ~ /^[A-Za-z_]+=[^ ]*$/ || \
             cmd ~ /^(local|return|shift|case|for|while|do|done|if|then|else|fi|unset|readonly|printf|echo|alias|shopt|set|type) / || \
             cmd ~ /^(true|false|:|done|fi|return)$/)
    if (prev_ts) {
      dt = ts - prev_ts
      if (dt > 0.001) {
        ctx = prev_cmd
        for (i = pipe_n; i >= 1; i--) ctx = pipe_cmds[i] " | " ctx
        if (pipe_n == 0 && prev_prev)
          ctx = prev_prev " | " ctx
        line = ctx " (" prev_src ")"
        if ((include_re == "" || line ~ include_re) && (exclude_re == "" || line !~ exclude_re)) {
          printf "%6.3fs  %s\n", dt, line
        }
      }
    }
    if (prev_ts && ts - prev_ts < 0.0001) {
      if (!noise && pipe_n < 3) pipe_cmds[++pipe_n] = prev_cmd
    } else {
      pipe_n = 0
    }
    if (!noise) prev_prev = prev_cmd
    prev_ts = ts; prev_cmd = cmd; prev_src = src
  }' "$trace_file" | sort -rn | head -30)"

  if [[ -n "${trace_output}" ]]; then
    echo "${trace_output}"
  elif [[ -n "${include_re}" ]] || [[ -n "${exclude_re}" ]]; then
    echo "(no operations matched filter and exceeded 1ms)"
  else
    echo "(no operations exceeded 1ms)"
  fi
}

# Profile dotfiles startup time; use --trace for per-command breakdown (bash 5+)
function dotfiles-profile() {
  local trace=0
  local include_re=
  local exclude_re=
  local arg
  while [[ $# -gt 0 ]]; do
    arg="$1"
    case "$arg" in
      --trace)
        trace=1
        shift
        ;;
      --filter)
        shift
        if [[ -z "${1:-}" ]]; then
          echo "dotfiles-profile: --filter requires a pattern" >&2
          return 1
        fi
        include_re="$1"
        shift
        ;;
      --exclude)
        shift
        if [[ -z "${1:-}" ]]; then
          echo "dotfiles-profile: --exclude requires a pattern" >&2
          return 1
        fi
        exclude_re="$1"
        shift
        ;;
      -h | --help)
        cat <<'EOF'
Usage: dotfiles-profile [--trace] [--filter PATTERN] [--exclude PATTERN]
  --trace            Print top slow operations from shell startup trace (bash 5+)
  --filter PATTERN   Include only trace lines matching PATTERN (regex)
  --exclude PATTERN  Exclude trace lines matching PATTERN (regex)
EOF
        return 0
        ;;
      *)
        echo "dotfiles-profile: unknown option '${arg}'" >&2
        return 1
        ;;
    esac
  done

  if ((trace)); then
    if ((BASH_VERSINFO[0] < 5)); then
      echo "dotfiles-profile: --trace requires bash 5+ for EPOCHREALTIME" >&2
      return 1
    fi
    local tmp
    tmp=$(mktemp)
    PS4='+ $EPOCHREALTIME ${BASH_SOURCE[0]:-shell}:$LINENO\011 ' "$BASH" -xi -c exit 2>|"$tmp"
    internal::trace-top-ops "$tmp" "Top 30 slowest operations:" "$include_re" "$exclude_re"
    rm -f "$tmp"
  else
    if [[ -n "${include_re}" ]] || [[ -n "${exclude_re}" ]]; then
      echo "dotfiles-profile: --filter/--exclude require --trace" >&2
      return 1
    fi
    time bash -i -c exit
    if ((BASH_VERSINFO[0] >= 5)); then
      echo "(use 'dotfiles-profile --trace' for per-command breakdown)"
    fi
  fi
}

# Current timestamp in microseconds.
function internal::now-us() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    echo "${EPOCHREALTIME/./}"
    return
  fi
  local ns
  ns="$(date +%s%N 2>/dev/null || true)"
  if [[ -n "${ns}" ]] && [[ "${ns}" != *N* ]]; then
    echo "$((ns / 1000))"
    return
  fi
  echo "$(($(date +%s) * 1000000))"
}

# Profile prompt rendering time in the current shell; use --trace for per-command breakdown (bash 5+)
function dotfiles-prompt-profile() {
  local trace=0
  local count=20
  local include_re=
  local exclude_re=
  local arg
  while [[ $# -gt 0 ]]; do
    arg="$1"
    case "$arg" in
      --trace)
        trace=1
        shift
        ;;
      --filter)
        shift
        if [[ -z "${1:-}" ]]; then
          echo "dotfiles-prompt-profile: --filter requires a pattern" >&2
          return 1
        fi
        include_re="$1"
        shift
        ;;
      --exclude)
        shift
        if [[ -z "${1:-}" ]]; then
          echo "dotfiles-prompt-profile: --exclude requires a pattern" >&2
          return 1
        fi
        exclude_re="$1"
        shift
        ;;
      --count)
        shift
        if [[ -z "${1:-}" ]] || ! [[ "${1}" =~ ^[0-9]+$ ]] || [[ "${1}" -lt 1 ]]; then
          echo "dotfiles-prompt-profile: --count requires a positive integer" >&2
          return 1
        fi
        count="${1}"
        shift
        ;;
      -h | --help)
        cat <<'EOF'
Usage: dotfiles-prompt-profile [--count N] [--trace] [--filter PATTERN] [--exclude PATTERN]
  --count N          Number of prompt renders to profile (default: 20)
  --trace            Print top slow operations across renders (requires bash 5+)
  --filter PATTERN   Include only trace lines matching PATTERN (regex)
  --exclude PATTERN  Exclude trace lines matching PATTERN (regex)
EOF
        return 0
        ;;
      *)
        echo "dotfiles-prompt-profile: unknown option '${arg}'" >&2
        return 1
        ;;
    esac
  done

  if [[ -z "${PS1:-}" ]]; then
    echo "dotfiles-prompt-profile: no PS1 found; run from an interactive shell" >&2
    return 1
  fi
  if ((BASH_VERSINFO[0] < 4)) || ((BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4)); then
    echo "dotfiles-prompt-profile: requires bash 4.4+ for prompt expansion" >&2
    return 1
  fi

  local prompt_cmd="${PROMPT_COMMAND:-:}"
  if [[ -z "${prompt_cmd}" ]]; then
    prompt_cmd=':'
  fi

  if ((trace)); then
    if ((BASH_VERSINFO[0] < 5)); then
      echo "dotfiles-prompt-profile: --trace requires bash 5+ for EPOCHREALTIME" >&2
      return 1
    fi
    local tmp
    tmp=$(mktemp)
    (
      local i
      PS4='+ $EPOCHREALTIME ${BASH_SOURCE[0]:-shell}:$LINENO\011 '
      set -x
      for ((i = 0; i < count; i++)); do
        eval "${prompt_cmd}"
        eval 'printf "%s" "${PS1@P}" >/dev/null'
      done
      set +x
    ) 2>|"$tmp"
    internal::trace-top-ops "$tmp" "Top 30 slowest prompt operations (${count} renders):" "$include_re" "$exclude_re"
    rm -f "$tmp"
    return 0
  fi

  if [[ -n "${include_re}" ]] || [[ -n "${exclude_re}" ]]; then
    echo "dotfiles-prompt-profile: --filter/--exclude require --trace" >&2
    return 1
  fi

  local i start_prompt end_prompt start_render end_render
  local -i total_prompt_us=0
  local -i total_render_us=0
  for ((i = 0; i < count; i++)); do
    start_prompt="$(internal::now-us)"
    eval "${prompt_cmd}"
    end_prompt="$(internal::now-us)"
    start_render="$(internal::now-us)"
    eval 'printf "%s" "${PS1@P}" >/dev/null'
    end_render="$(internal::now-us)"
    total_prompt_us=$((total_prompt_us + end_prompt - start_prompt))
    total_render_us=$((total_render_us + end_render - start_render))
  done

  local -i total_us=$((total_prompt_us + total_render_us))
  local -i avg_prompt_us=$((total_prompt_us / count))
  local -i avg_render_us=$((total_render_us / count))
  local -i avg_total_us=$((total_us / count))
  local cwd="${PWD/#${HOME}/~}"

  echo "Prompt profile (${count} renders in ${cwd}):"
  printf '  PROMPT_COMMAND total: %6d.%03d ms  avg: %5d.%03d ms\n' \
    "$((total_prompt_us / 1000))" "$((total_prompt_us % 1000))" \
    "$((avg_prompt_us / 1000))" "$((avg_prompt_us % 1000))"
  printf '  PS1 expansion total:  %6d.%03d ms  avg: %5d.%03d ms\n' \
    "$((total_render_us / 1000))" "$((total_render_us % 1000))" \
    "$((avg_render_us / 1000))" "$((avg_render_us % 1000))"
  printf '  Combined total:       %6d.%03d ms  avg: %5d.%03d ms\n' \
    "$((total_us / 1000))" "$((total_us % 1000))" \
    "$((avg_total_us / 1000))" "$((avg_total_us % 1000))"

  if ((BASH_VERSINFO[0] >= 5)); then
    echo "(use 'dotfiles-prompt-profile --trace --count ${count}' for per-command breakdown)"
  fi
}
