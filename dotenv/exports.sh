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

# set $EDITOR to vi(m) if not already set
export EDITOR="${EDITOR:-$(command -v vim &>/dev/null && echo vim || echo vi)}"
