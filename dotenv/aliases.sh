# shellcheck shell=bash
# Define common shell aliases.
# SPDX-License-Identifier: MIT

# Easier navigation: .., ..., ~ and -
alias ..="cd .."
alias ...="cd ../.."
alias ....="cd ../../.."
alias ~="cd ~"
alias -- -="cd -"

# Shortcuts

# useful shortcuts
alias h="history"
alias o="open"
alias oo="open ."

# Interactive rm, cp, and mv
alias rm="rm -i"
alias cp="cp -i"
alias mv="mv -i"

# Basic color aliases for grep and ls.  plugins/05-ls.sh upgrades the ls
# family with OSC 8 hyperlinks; plugins/10-eza.sh overrides with eza.
function internal::basic-grep-ls-aliases() {
  local LS_COLOR_FLAG LS_BIN GREP_BIN
  LS_BIN="$(
    unalias ls &>/dev/null
    command -v ls
  )"
  GREP_BIN="$(
    unalias grep &>/dev/null
    command -v grep
  )"

  # Colorize grep matches
  if echo | "${GREP_BIN}" --color=auto &>/dev/null; then
    # shellcheck disable=SC2139
    alias grep="${GREP_BIN} --color=auto"
    # shellcheck disable=SC2139
    alias fgrep="${GREP_BIN} -F --color=auto"
    # shellcheck disable=SC2139
    alias egrep="${GREP_BIN} -E --color=auto"
  fi

  # Detect which ls flavor is in use
  if "${LS_BIN}" --color &>/dev/null; then
    LS_COLOR_FLAG="--color=auto"
  else
    LS_COLOR_FLAG="-G"
  fi
  # shellcheck disable=SC2139
  alias la="${LS_BIN} -lA ${LS_COLOR_FLAG}"
  # shellcheck disable=SC2139
  alias ll="${LS_BIN} -l ${LS_COLOR_FLAG}"
  # shellcheck disable=SC2139
  alias l.="${LS_BIN} -d ${LS_COLOR_FLAG} .*"
  # shellcheck disable=SC2139
  alias ls="${LS_BIN} ${LS_COLOR_FLAG}"

  if "${LS_BIN}" --format=long &>/dev/null; then
    # shellcheck disable=SC2139
    alias dir="${LS_BIN} ${LS_COLOR_FLAG} --format=vertical"
    # shellcheck disable=SC2139
    alias vdir="${LS_BIN} ${LS_COLOR_FLAG} --format=long"
  fi

  unset -f internal::basic-grep-ls-aliases
}
internal::basic-grep-ls-aliases

# allow which command to expand
# shellcheck disable=SC2230
if which --tty-only which >/dev/null 2>&1; then
  alias which="alias | /usr/bin/which --tty-only --read-alias --show-dot --show-tilde"
fi

# shortcut to parallel-xargs
alias x="parallel-xargs"

# alias for date conversion
alias totime="date2unix"
alias fromtime="unix2date"

# Enable aliases to be sudo'ed
alias sudo="sudo "

# Networking shortcuts
alias extip="curl -s https://api.ipify.org/?format=text"

# Reload the current shell
# shellcheck disable=SC2139
alias reload="exec ${SHELL} -l"

# Alias vi to a found editor
# shellcheck disable=SC2139
alias vi="$(internal::find-editor)"
