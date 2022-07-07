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

# cd replacement to show cd history with cd --
alias cd="__cd_func"

# Interactive rm, cp, and mv
alias rm="rm -i"
alias cp="cp -i"
alias mv="mv -i"

# Colorize grep matches
# test if color is supported, if it is, always add color
if echo | grep --color=auto &>/dev/null; then
  alias grep="grep --color=auto"
  alias fgrep="fgrep --color=auto"
  alias egrep="egrep --color=auto"
fi

# Detect which `ls` flavor is in use
if ls --color &>/dev/null; then
  # GNU ls
  LS_COLOR_FLAG="--color=auto"
else
  # darwin ls
  LS_COLOR_FLAG="-G"
fi
# Specialized directory listings
# shellcheck disable=SC2139
alias la="ls -lA ${LS_COLOR_FLAG}"
# shellcheck disable=SC2139
alias ll="ls -l ${LS_COLOR_FLAG}"
# shellcheck disable=SC2139
alias l.="ls -d ${LS_COLOR_FLAG} .*"
# shellcheck disable=SC2139
alias ls="ls ${LS_COLOR_FLAG}"
# shellcheck disable=SC2139
alias lf="ls -l ${LS_COLOR_FLAG} | grep '^d'"

# check if we can display in long format
if ls --format=long >/dev/null 2>&1; then
  # shellcheck disable=SC2139
  alias dir="ls ${LS_COLOR_FLAG} --format=vertical"
  # shellcheck disable=SC2139
  alias vdir="ls ${LS_COLOR_FLAG} --format=long"
fi

unset LS_COLOR_FLAG

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
alias extip="curl -s http://whatismyip.akamai.com/ | sed 's/[^0-9\.]//g'"

# Reload the current shell
# shellcheck disable=SC2139
alias reload="exec ${SHELL} -l"
