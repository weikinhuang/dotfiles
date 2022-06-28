# shellcheck shell=bash

# Shell Options
# Use case-insensitive filename globbing
shopt -s nocaseglob 2>/dev/null

# Include . files when globing (ie. mv, cp, etc.)
shopt -s dotglob 2>/dev/null

# When changing directory small typos can be ignored by bash
shopt -s cdspell 2>/dev/null

# Append to the Bash history file, rather than overwriting it
shopt -s histappend 2>/dev/null

# Try to enable some bash 4 functionality
# Attempt to auto cd to a directory
shopt -s autocd 2>/dev/null
# Recursive globbing, e.g. `echo **/*.txt`
shopt -s globstar 2>/dev/null
# If any jobs are running, this causes the exit to be deferred until a second exit is attempted
shopt -s checkjobs 2>/dev/null

# check the window size after each command and, if necessary,
# update the values of LINES and COLUMNS.
shopt -s checkwinsize 2>/dev/null

# @see https://www.gnu.org/software/bash/manual/bash.html#The-Set-Builtin
if [[ -n "${DOT_BASH_RESOLVE_PATHS:-}" ]]; then
  # same as -P
  # If set, do not resolve symbolic links when performing commands such as cd which change the current directory. The physical
  # directory is used instead. By default, Bash follows the logical chain of directories when performing commands which change
  # the current directory.
  set -o physical
fi
unset DOT_BASH_RESOLVE_PATHS
