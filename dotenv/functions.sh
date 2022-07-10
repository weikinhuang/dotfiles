# shellcheck shell=bash

# push a command to the prompt command
function __push_prompt_command() {
  local command="${1/%;/}"
  PROMPT_COMMAND="$(echo "$(echo "${PROMPT_COMMAND/%;/}" | tr ';' '\n' | grep -v -F "${command}" | grep -v '^ *$' | tr '\n' ';')${command};" | sed 's/;;/;/' | sed 's/^;//')"
}

# internal prompt command stack to simplify the PROMPT_COMMAND variable
declare -a __prompt_actions
function __push_internal_prompt_command() {
  local command="${1/%;/}"
  __prompt_actions+=("${command}")
}
function __run_prompt_command() {
  for l in "${__prompt_actions[@]}"; do
    eval "$l"
  done
}

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

# find files with case-insensetive matching in current directory
function findhere() {
  find . -iname "*$1*"
}

# do a case-insensetive grep on all the files in a directory
function grip() {
  grep -ir "$1" .
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
  if [ -f "$1" ]; then
    case "$1" in
      *.tar.bz2)
        tar xjf "$@"
        ;;
      *.tar.gz)
        tar xzf "$@"
        ;;
      *.bz2)
        bunzip2 "$@"
        ;;
      *.rar)
        rar x "$@"
        ;;
      *.gz)
        gunzip "$@"
        ;;
      *.tar)
        tar xf "$@"
        ;;
      *.tbz2)
        tar xjf "$@"
        ;;
      *.tgz)
        tar xzf "$@"
        ;;
      *.zip)
        unzip "$@"
        ;;
      *.Z)
        uncompress "$@"
        ;;
      *.7z)
        7z x "$@"
        ;;
      *)
        echo "'$1' cannot be extracted via extract()"
        ;;
    esac
  else
    echo "'$1' is not a valid file"
  fi
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

# Use Git's colored diff when available
if command -v git &>/dev/null; then
  function diff() {
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
    date --date "$*" +%s
    return
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
