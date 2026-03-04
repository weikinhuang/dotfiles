# shellcheck shell=bash

# update the dotfiles repo
function dotfiles-update() (
  # shellcheck disable=SC2164
  cd "${DOTFILES__ROOT}/.dotfiles"
  git pull origin master
  ./bootstrap.sh
)

# Count the number of files in a directory
function cf() {
  find "${1-.}" -type f | wc -l
}

# xargs wrapper for running PROC_CORES parallel processes
function parallel-xargs() {
  local cmd="$*"
  if [[ ! "$cmd" =~ "{}" ]]; then
    cmd="$cmd {}"
  fi
  xargs -r -I {} -P "${PROC_CORES:-1}" sh -c "${cmd}"
}

# Extract archives automatically
function extract() {
  if [ ! -f "$1" ]; then
    echo "'$1' is not a valid file" >&2
    return 1
  fi
  local cmd
  case "$1" in
    *.tar.bz2) cmd="tar xjf" ;;
    *.tar.gz) cmd="tar xzf" ;;
    *.tar.xz) cmd="tar xJf" ;;
    *.tar.zst) cmd="tar --zstd -xf" ;;
    *.bz2) cmd="bunzip2" ;;
    *.rar) cmd="rar x" ;;
    *.gz) cmd="gunzip" ;;
    *.xz) cmd="unxz" ;;
    *.zst) cmd="unzstd" ;;
    *.tar) cmd="tar xf" ;;
    *.tbz2) cmd="tar xjf" ;;
    *.tgz) cmd="tar xzf" ;;
    *.zip) cmd="unzip" ;;
    *.Z) cmd="uncompress" ;;
    *.7z) cmd="7z x" ;;
    *)
      echo "'$1' cannot be extracted via extract()" >&2
      return 1
      ;;
  esac
  local tool="${cmd%% *}"
  if ! command -v "$tool" &>/dev/null; then
    echo "extract: '$tool' is not installed" >&2
    return 1
  fi
  $cmd "$@"
}

# Get gzipped file size
function gz-size() {
  echo -n "original (bytes): "
  wc -c <"${1}"
  echo -n "gzipped (bytes):  "
  gzip -c "${1}" | wc -c
}

# Create a new directory and enter it
function md() {
  mkdir -p "$@" && cd "$@" || return 1
}

# Git's colored diff (avoids overriding system diff)
if command -v git &>/dev/null; then
  function gdiff() {
    git diff --no-index --color "$@"
  }
fi

# Create a data URL from an image (works for other file types too, if you tweak the Content-Type afterwards)
function dataurl() {
  echo "data:image/${1##*.};base64,$(openssl base64 -in "$1")" | tr -d '\n'
}

# Gzip-enabled `curl`
function curl-gz() {
  curl -sH "Accept-Encoding: gzip" "$@" | gunzip
}

# Escape UTF-8 characters into their 3-byte format
function escape() {
  # shellcheck disable=SC2046,SC2059
  printf "\\\x%s" $(printf "$@" | xxd -p -c1 -u)
  echo # newline
}

# Decode \x{ABCD}-style Unicode escape sequences
function unidecode() {
  perl -e "binmode(STDOUT, ':utf8'); print \"$*\""
  echo # newline
}

# Get a character's Unicode code point
function codepoint() {
  perl -e "use utf8; print sprintf('U+%04X', ord(\"$*\"))"
  echo # newline
}

# Convert a unix timestamp to a date string
function unix2date() {
  if [[ -n "$1" ]]; then
    echo "$1" | awk '{print strftime("%c", $1)}'
    return
  fi
  date
}

# Convert a date string to a unix timestamp
function date2unix() {
  if [[ -n "$1" ]]; then
    if date --date "$*" +%s 2>/dev/null; then
      return
    fi
    # GNU coreutils date on macOS (brew install coreutils)
    if command -v gdate &>/dev/null && gdate --date "$*" +%s 2>/dev/null; then
      return
    fi
    # BSD/macOS fallback
    date -j -f "%a, %b %d, %Y %I:%M:%S %p" "$*" +%s 2>/dev/null && return
    date -j -f "%Y-%m-%d %H:%M:%S" "$*" +%s 2>/dev/null && return
    date -j -f "%Y-%m-%d" "$*" +%s 2>/dev/null && return
    echo "date2unix: unable to parse '$*'" >&2
    return 1
  fi
  date +%s
}

# Convert to lowercase.
function lc() {
  tr '[:upper:]' '[:lower:]'
}

# Convert to uppercase.
function uc() {
  tr '[:lower:]' '[:upper:]'
}

# regex match and replace from: https://gist.github.com/opsb/4409156
function regex() {
  gawk "match(\$0, /${1}/, ary) { print ary[${2:-0}] }"
}

# binary diff
function binarydiff() {
  vimdiff <(xxd "${1}") <(xxd "${2}")
}

# Summarize traced shell operations and print top slowest entries.
function __dot_trace_top_ops() {
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
    __dot_trace_top_ops "$tmp" "Top 30 slowest operations:" "$include_re" "$exclude_re"
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
function __dot_now_us() {
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
  echo "$(( $(date +%s) * 1000000 ))"
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
    __dot_trace_top_ops "$tmp" "Top 30 slowest prompt operations (${count} renders):" "$include_re" "$exclude_re"
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
    start_prompt="$(__dot_now_us)"
    eval "${prompt_cmd}"
    end_prompt="$(__dot_now_us)"
    start_render="$(__dot_now_us)"
    eval 'printf "%s" "${PS1@P}" >/dev/null'
    end_render="$(__dot_now_us)"
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
