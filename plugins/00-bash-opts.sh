# shellcheck shell=bash

# ------------------------------------------------------------------------------
# Shell Options
# ------------------------------------------------------------------------------
# Use case-insensitive filename globbing
shopt -s nocaseglob 2>/dev/null

# Include . files when globing (ie. mv, cp, etc.)
shopt -s dotglob 2>/dev/null

# When changing directory small typos can be ignored by bash
shopt -s cdspell 2>/dev/null

# Try to enable some bash 4 functionality

# Recursive globbing, e.g. `echo **/*.txt`
shopt -s globstar 2>/dev/null
# If any jobs are running, this causes the exit to be deferred until a second exit is attempted
shopt -s checkjobs 2>/dev/null

# check the window size after each command and, if necessary,
# update the values of LINES and COLUMNS.
shopt -s checkwinsize 2>/dev/null

# Prevent file overwrite on stdout redirection
# Use `>|` to force redirection to an existing file
set -o noclobber 2>/dev/null

# @see https://www.gnu.org/software/bash/manual/bash.html#The-Set-Builtin
if [[ -n "${DOT_BASH_RESOLVE_PATHS:-}" ]]; then
  # same as -P
  # If set, do not resolve symbolic links when performing commands such as cd which change the current directory. The physical
  # directory is used instead. By default, Bash follows the logical chain of directories when performing commands which change
  # the current directory.
  set -o physical
fi
unset DOT_BASH_RESOLVE_PATHS

# disable terminal locking with CTRL+s
stty -ixon
# Allow C-W mapping in inputrc to work
# see https://unix.stackexchange.com/q/296822/63527
# stty werase undef

# ------------------------------------------------------------------------------
# History Options
# ------------------------------------------------------------------------------
# Append to the Bash history file, rather than overwriting it
shopt -s histappend 2>/dev/null
# Use one command per line in histfile
shopt -s cmdhist 2>/dev/null

# remove dupicate line higher in history before appending
# Don't put duplicate lines in the history.
export HISTCONTROL="${HISTCONTROL}${HISTCONTROL+:}erasedups:ignoreboth"
# Ignore some controlling instructions: exit, ls, empty cd, pwd, date, help pages
HISTIGNORE_BASE=$'[ \t]*:&:[fb]g:exit:jobs:ls:ls -?::ls -??:ll:history:cd:cd -:cd ~:cd ..:..:pwd:date:* --help:* help'
# Ignore basic git commands
HISTIGNORE_GIT='git +([a-z]):git co -:git add -?:git pob -f:git pr -o:git undo .:git diff --staged'
# Ignore common local commands
HISTIGNORE_LOCAL='o:oo'
# Ignore common dev commands
HISTIGNORE_DEV='p:npm install:bower install'
# export combined HISTIGNORE
export HISTIGNORE=${HISTIGNORE}:${HISTIGNORE_BASE}:${HISTIGNORE_GIT}:${HISTIGNORE_LOCAL}:${HISTIGNORE_DEV}
# Larger bash history (default is 500)
export HISTSIZE=1000000
export HISTFILESIZE=$HISTSIZE
# Use timestamp
# %F equivalent to %Y-%m-%d
# %T equivalent to %H:%M:%S (24-hours format)
export HISTTIMEFORMAT='%F %T '

# ------------------------------------------------------------------------------
# Navigation Options (cd)
# ------------------------------------------------------------------------------
# Attempt to auto cd to a directory
shopt -s autocd 2>/dev/null
# Correct spelling errors during tab-completion
shopt -s dirspell 2>/dev/null
# Correct spelling errors in arguments supplied to cd
shopt -s cdspell 2>/dev/null

# This defines where cd looks for targets
CDPATH="."
