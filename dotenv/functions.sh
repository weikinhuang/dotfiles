# shellcheck shell=bash
# Define common shell functions for the dotfiles.
# SPDX-License-Identifier: MIT

# Rewrite file:// URLs in OSC 8 hyperlinks emitted by a command.  On WSL,
# paths under /mnt/[a-z]/ are Windows drive mounts and are converted to
# native Windows file:// URLs (file:///D:/...) since the wsl.localhost UNC
# path gets access denied for these.  All other WSL paths use the
# wsl.localhost authority so Windows apps can resolve them.  When stdout is
# not a terminal the command runs directly with hyperlink flags stripped.
function internal::osc8-rewrite() {
  if [[ ! -t 1 ]]; then
    local __dot_args=()
    local __dot_arg
    for __dot_arg in "$@"; do
      case "${__dot_arg}" in
        --hyperlink | --hyperlink=*) ;;
        *) __dot_args+=("${__dot_arg}") ;;
      esac
    done
    "${__dot_args[@]}"
    return
  fi

  if [[ -n "${DOT___IS_WSL:-}" ]]; then
    COLUMNS="${COLUMNS:-80}" "$@" --color=always \
      | command sed \
        -e "s,\x1b]8;;file://[^/]*/mnt/\([a-z]\)/,\x1b]8;;__WSLDRV__/\U\1\E:/,g" \
        -e "s,\x1b]8;;file://[^/]*/,\x1b]8;;file://wsl.localhost/${WSL_DISTRO_NAME}/,g" \
        -e "s,__WSLDRV__/,file:///,g"
    return "${PIPESTATUS[0]}"
  else
    "$@"
  fi
}

# Count the number of files in a directory
function cf() {
  find "${1-.}" -type f | wc -l
}

# xargs wrapper for running PROC_CORES parallel processes
function parallel-xargs() {
  if [[ $# -eq 0 ]]; then
    echo "Usage: parallel-xargs <command> [args...]" >&2
    return 1
  fi

  local -a cmd=("$@")
  local has_placeholder=
  local arg
  for arg in "${cmd[@]}"; do
    if [[ "${arg}" == "{}" ]]; then
      has_placeholder=1
      break
    fi
  done
  if [[ -z "${has_placeholder}" ]]; then
    cmd+=("{}")
  fi

  local -a xargs_opts=(-I {} -P "${PROC_CORES:-1}")
  # GNU xargs supports -r (don't run when stdin is empty); BSD xargs does not
  if printf '' | command xargs -r true 2>/dev/null; then
    xargs_opts=(-r "${xargs_opts[@]}")
  fi
  xargs "${xargs_opts[@]}" "${cmd[@]}"
}

# Extract archives automatically
function extract() {
  if [[ ! -f "$1" ]]; then
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
  local -a cmd_arr
  read -ra cmd_arr <<<"$cmd"
  "${cmd_arr[@]}" "$@"
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
  if [[ $# -ne 1 ]]; then
    echo "md: expected exactly one directory argument, got $#" >&2
    return 2
  fi
  mkdir -p "$1" && cd "$1" || return 1
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
  perl -e 'binmode(STDOUT, ":utf8"); print @ARGV' -- "$*"
  echo # newline
}

# Get a character's Unicode code point
function codepoint() {
  perl -e 'use utf8; print sprintf("U+%04X", ord($ARGV[0]))' -- "$*"
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
  # -v passes pattern/index as runtime strings; inlining them allows code injection.
  gawk -v pat="${1}" -v idx="${2:-0}" 'match($0, pat, ary) { print ary[idx] }'
}

# binary diff
function binarydiff() {
  vimdiff <(xxd "${1}") <(xxd "${2}")
}
