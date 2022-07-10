# shellcheck shell=bash
# Easier navigation: .., ..., ~ and -
alias ..="cd .."
alias ...="cd ../.."
alias ....="cd ../../.."
alias ~="cd ~"
alias -- -="cd -"

# Shortcuts

# useful shortcuts
alias h="history"
alias f="findhere"
alias o="open"
alias oo="open ."

# Interactive rm, cp, and mv
alias rm="rm -i"
alias cp="cp -i"
alias mv="mv -i"

# run this after plugins are loaded in case gnu grep and gnu ls is added to path in plugins
function __grep_ls_colors() {
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
  # test if color is supported, if it is, always add color
  if echo | "${GREP_BIN}" --color=auto &>/dev/null; then
    # shellcheck disable=SC2139
    alias grep="${GREP_BIN} --color=auto"
    alias fgrep="fgrep --color=auto"
    alias egrep="egrep --color=auto"
  fi

  # Detect which `ls` flavor is in use
  if "${LS_BIN}" --color &>/dev/null; then
    # GNU ls
    LS_COLOR_FLAG="--color=auto"
  else
    # darwin ls
    LS_COLOR_FLAG="-G"
  fi
  # Specialized directory listings
  # shellcheck disable=SC2139
  alias la="${LS_BIN} -lA ${LS_COLOR_FLAG}"
  # shellcheck disable=SC2139
  alias ll="${LS_BIN} -l ${LS_COLOR_FLAG}"
  # shellcheck disable=SC2139
  alias l.="${LS_BIN} -d ${LS_COLOR_FLAG} .*"
  # shellcheck disable=SC2139
  alias ls="${LS_BIN} ${LS_COLOR_FLAG}"
  # shellcheck disable=SC2139
  alias lf="${LS_BIN} -l ${LS_COLOR_FLAG} | grep '^d'"

  # check if we can display in long format
  if "${LS_BIN}" --format=long &>/dev/null; then
    # shellcheck disable=SC2139
    alias dir="ls ${LS_COLOR_FLAG} --format=vertical"
    # shellcheck disable=SC2139
    alias vdir="ls ${LS_COLOR_FLAG} --format=long"
  fi

  unset -f __grep_ls_colors
}
dotfiles_hook_plugin_post_functions+=(__grep_ls_colors)

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
alias vi="$(__find_editor)"
