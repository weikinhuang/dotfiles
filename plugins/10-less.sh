# shellcheck shell=bash
# Configure less defaults for interactive shells.
# SPDX-License-Identifier: MIT

# Don't clear the screen after quitting a manual page
export MANPAGER="less -iFXRS -x4"

# Set global less defaults: raw control chars, quit-if-one-screen, don't clear screen
export LESS="${LESS:--iFRX}"

# Highlight section titles in manual pages if possible
if tput setaf 1 &>/dev/null; then
  : "${LESS_TERMCAP_mb:=$'\e[1;32m'}"
  : "${LESS_TERMCAP_md:=$'\e[1;32m'}"
  : "${LESS_TERMCAP_me:=$'\e[0m'}"
  : "${LESS_TERMCAP_se:=$'\e[0m'}"
  : "${LESS_TERMCAP_so:=$'\e[01;33m'}"
  : "${LESS_TERMCAP_ue:=$'\e[0m'}"
  : "${LESS_TERMCAP_us:=$'\e[1;4;31m'}"

  export "${!LESS_TERMCAP@}"
fi

# Make 'less' not clear the screen upon exit and process colors
alias less="less -FRX"
