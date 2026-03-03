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

# Profile dotfiles startup time; use --trace for per-command breakdown (bash 5+)
function dotfiles-profile() {
  if [[ "${1:-}" == "--trace" ]]; then
    if ((BASH_VERSINFO[0] < 5)); then
      echo "dotfiles-profile: --trace requires bash 5+ for EPOCHREALTIME" >&2
      return 1
    fi
    local tmp
    tmp=$(mktemp)
    PS4='+ $EPOCHREALTIME ${BASH_SOURCE[0]:-shell}:$LINENO\011 ' "$BASH" -xi -c exit 2>|"$tmp"
    echo "Top 30 slowest operations:"
    LC_ALL=C awk -F'\t' -v home="$HOME" '/^\++ [0-9]+\./ {
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
          printf "%6.3fs  %s  (%s)\n", dt, ctx, prev_src
        }
      }
      if (prev_ts && ts - prev_ts < 0.0001) {
        if (!noise && pipe_n < 3) pipe_cmds[++pipe_n] = prev_cmd
      } else {
        pipe_n = 0
      }
      if (!noise) prev_prev = prev_cmd
      prev_ts = ts; prev_cmd = cmd; prev_src = src
    }' "$tmp" | sort -rn | head -30
    rm -f "$tmp"
  else
    time bash -i -c exit
    if ((BASH_VERSINFO[0] >= 5)); then
      echo "(use 'dotfiles-profile --trace' for per-command breakdown)"
    fi
  fi
}
