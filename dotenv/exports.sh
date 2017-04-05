# LC_ configuration
export LC_ALL=en_US.UTF-8
# Set user-defined locale
export LANG=en_US.UTF-8

# Completion options
COMP_CVS_REMOTE=1
# Define to avoid stripping description in --option=description of './configure --help'
COMP_CONFIGURE_HINTS=1
# Define to avoid flattening internal contents of tar files
COMP_TAR_INTERNAL_PATHS=1
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
if tput setaf 1 &> /dev/null; then
  export LESS_TERMCAP_md="$(tput bold)$(tput setaf 33)"
fi
