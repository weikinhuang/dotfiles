# shellcheck shell=bash
# Configure baseline Bash shell options.
# SPDX-License-Identifier: MIT

# ------------------------------------------------------------------------------
# Shell Options
# ------------------------------------------------------------------------------
# Use case-insensitive filename globbing
shopt -s nocaseglob 2>/dev/null

# Include . files when globing (ie. mv, cp, etc.)
shopt -s dotglob 2>/dev/null

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

# Ensure consistent file permissions across environments (owner rw, group r, other r)
umask 022

# disable terminal locking with CTRL+s (stty needs a TTY on stdin)
if [[ -t 0 ]]; then
  stty -ixon
fi
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
# Preview history expansion before executing (e.g. !! shows the expansion first)
shopt -s histverify 2>/dev/null

# remove dupicate line higher in history before appending
# Don't put duplicate lines in the history.
export HISTCONTROL="${HISTCONTROL}${HISTCONTROL+:}ignoreboth"
# Ignore some controlling instructions: exit, ls, empty cd, pwd, date, help pages
__dot_histignore_base=$'[ \t]*:&:[fb]g:exit:jobs:ls:ls -?::ls -??:ll:history:cd:cd -:cd ~:cd ..:..:pwd:date:* --help:* help'
# Ignore basic git commands
__dot_histignore_git='git +([a-z]):git co -:git add -?:git pob -f:git pr -o:git undo .:git diff --staged'
# Ignore common local commands
__dot_histignore_local='o:oo'
# Ignore common dev commands
__dot_histignore_dev='p:npm install:bower install'
# export combined HISTIGNORE
export HISTIGNORE=${HISTIGNORE}:${__dot_histignore_base}:${__dot_histignore_git}:${__dot_histignore_local}:${__dot_histignore_dev}
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

unset -v __dot_histignore_base __dot_histignore_git __dot_histignore_local __dot_histignore_dev
