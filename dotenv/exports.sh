# shellcheck shell=bash
# Export shared environment defaults.
# SPDX-License-Identifier: MIT

# supress "bash: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8): No such file or directory"
# LC_ configuration
export LC_ALL=en_US.UTF-8 &>/dev/null
# Set user-defined locale
export LANG=en_US.UTF-8 &>/dev/null

# XDG Base Directory defaults
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"

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

# set $EDITOR if not already set
EDITOR="${EDITOR:-$(internal::find-editor)}"
export EDITOR
VISUAL="${VISUAL:-$EDITOR}"
export VISUAL
PAGER="${PAGER:-less}"
export PAGER

# opt out of telemetry collection for tools that support this environment variable
export DO_NOT_TRACK=1
