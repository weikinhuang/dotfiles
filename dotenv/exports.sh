# shellcheck shell=bash

# supress "bash: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8): No such file or directory"
# LC_ configuration
export LC_ALL=en_US.UTF-8 &>/dev/null
# Set user-defined locale
export LANG=en_US.UTF-8 &>/dev/null

# Completion options
COMP_CVS_REMOTE=1
export COMP_CVS_REMOTE
# Define to avoid stripping description in --option=description of './configure --help'
COMP_CONFIGURE_HINTS=1
export COMP_CONFIGURE_HINTS
# Define to avoid flattening internal contents of tar files
COMP_TAR_INTERNAL_PATHS=1
export COMP_TAR_INTERNAL_PATHS
# Make = a wordbreak character
COMP_WORDBREAKS=${COMP_WORDBREAKS/=/}

# History Options
# Don't put duplicate lines in the history.
export HISTCONTROL="${HISTCONTROL}${HISTCONTROL+,}ignoredups"
# Ignore some controlling instructions: exit, ls, empty cd, pwd, date, help pages
HISTIGNORE_BASE=$'[ \t]*:&:[fb]g:exit:ls:ls -?::ls -??:ll:history:cd:cd -:cd ~:cd ..:..:pwd:date:* --help:* help'
# Ignore basic git commands
HISTIGNORE_GIT='git +([a-z]):git co -:git add -?:git pob -f:git pr -o:git undo .:git diff --staged'
# Ignore common local commands
HISTIGNORE_LOCAL='o:oo'
# Ignore common dev commands
HISTIGNORE_DEV='p:npm install:bower install'
# export combined HISTIGNORE
export HISTIGNORE=${HISTIGNORE}:${HISTIGNORE_BASE}:${HISTIGNORE_GIT}:${HISTIGNORE_LOCAL}:${HISTIGNORE_DEV}
# Larger bash history (allow 32³ entries; default is 500)
export HISTSIZE=32768
export HISTFILESIZE=$HISTSIZE

# Don't clear the screen after quitting a manual page
export MANPAGER="less -iFXRS -x4"
# Highlight section titles in manual pages if possible
if tput setaf 1 &>/dev/null; then
  : "${LESS_TERMCAP_mb:=$'\e[1;32m'}"
  : "${LESS_TERMCAP_md:=$'\e[1;32m'}"
  : "${LESS_TERMCAP_me:=$'\e[0m'}"
  : "${LESS_TERMCAP_se:=$'\e[0m'}"
  : "${LESS_TERMCAP_so:=$'\e[01;33m'}"
  : "${LESS_TERMCAP_ue:=$'\e[0m'}"
  : "${LESS_TERMCAP_us:=$'\e[1;4;31m'}"

  : "${LESS:=}"
  export "${!LESS_TERMCAP@}"
  export LESS="R${LESS#-}"
fi

# set $EDITOR to vi(m) if not already set
export EDITOR="${EDITOR:-$(command -v vim &>/dev/null && echo vim || echo vi)}"
