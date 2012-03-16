# To the extent possible under law, the author(s) have dedicated all 
# copyright and related and neighboring rights to this software to the 
# public domain worldwide. This software is distributed without any warranty. 
# You should have received a copy of the CC0 Public Domain Dedication along 
# with this software. 
# If not, see <http://creativecommons.org/publicdomain/zero/1.0/>. 

# base-files version 4.1-1

# ~/.bashrc: executed by bash(1) for interactive shells.

# The latest version as installed by the Cygwin Setup program can
# always be found at /etc/defaults/etc/skel/.bashrc

# Modifying /etc/skel/.bashrc directly will prevent
# setup from updating it.

# The copy in your home directory (~/.bashrc) is yours, please
# feel free to customise it to create a shell
# environment to your liking.  If you feel a change
# would be benifitial to all, please feel free to send
# a patch to the cygwin mailing list.

# User dependent .bashrc file

# If not running interactively, don't do anything
[[ "$-" != *i* ]] && return

# Shell Options
#
# See man bash for more options...
#
# Don't wait for job termination notification
# set -o notify
#
# Don't use ^D to exit
# set -o ignoreeof
#
# Use case-insensitive filename globbing
# shopt -s nocaseglob
#
# Make bash append rather than overwrite the history on disk
# shopt -s histappend
#
# When changing directory small typos can be ignored by bash
# for example, cd /vr/lgo/apaache would find /var/log/apache
# shopt -s cdspell

# Completion options
#
# These completion tuning parameters change the default behavior of bash_completion:
#
# Define to access remotely checked-out files over passwordless ssh for CVS
# COMP_CVS_REMOTE=1
#
# Define to avoid stripping description in --option=description of './configure --help'
# COMP_CONFIGURE_HINTS=1
#
# Define to avoid flattening internal contents of tar files
# COMP_TAR_INTERNAL_PATHS=1
#
# Uncomment to turn on programmable completion enhancements.
# Any completions you add in ~/.bash_completion are sourced last.
# [[ -f /etc/bash_completion ]] && . /etc/bash_completion

# History Options
#
# Don't put duplicate lines in the history.
# export HISTCONTROL=$HISTCONTROL${HISTCONTROL+,}ignoredups
#
# Ignore some controlling instructions
# HISTIGNORE is a colon-delimited list of patterns which should be excluded.
# The '&' is a special pattern which suppresses duplicate entries.
# export HISTIGNORE=$'[ \t]*:&:[fb]g:exit'
# export HISTIGNORE=$'[ \t]*:&:[fb]g:exit:ls' # Ignore the ls command as well
#
# Whenever displaying the prompt, write the previous line to disk
# export PROMPT_COMMAND="history -a"

# Umask
#
# /etc/profile sets 022, removing write perms to group + others.
# Set a more restrictive umask: i.e. no exec perms for others:
# umask 027
# Paranoid: neither group nor others have any perms:
# umask 077

# wrapped shortcuts to windows programs
if [ -d "/winprogs" ] ; then
  PATH="${PATH}:/winprogs"
fi

if [ -f "${HOME}/.bash_aliases" ]; then
  source "${HOME}/.bash_aliases"
fi

if [ -f "${HOME}/.bash_functions" ]; then
  source "${HOME}/.bash_functions"
fi

# Completion options
COMP_CVS_REMOTE=1
# Define to avoid stripping description in --option=description of './configure --help'
COMP_CONFIGURE_HINTS=1
# Define to avoid flattening internal contents of tar files
COMP_TAR_INTERNAL_PATHS=1
if [ -f "/etc/bash_completion" ]; then
  source "/etc/bash_completion"
fi

# History Options
# Don't put duplicate lines in the history.
export HISTCONTROL=$HISTCONTROL${HISTCONTROL+,}ignoredups
# Ignore some controlling instructions
export HISTIGNORE=$'[ \t]*:&:[fb]g:exit:ls' # Ignore the ls command as well

# show git status
GIT_PS1_SHOWDIRTYSTATE=true
SVN_PS1_SHOWDIRTYSTATE=true

# bash prompt
#   titlebar
#   open bracket
#   time
#   load
#   user@host
#   working directory
#   repository status
#   close bracket
PS1='\
\[\e]0;\u@\h:\W\007\]\
[\
\[\e[37m\]$(date +"%r" | sed -n "s/ [AMPamp]\+//p" | tr " " "0")\[\e[m\] \
\[\e[0;35m\]$(printf "%05s" $(typeperf -sc 1 "\processor(_total)\% processor time" | sed -n "s/.\+,\"\([0-9]\+\.[0-9][0-9]\).\+/\1/p"))%\[\e[m\] \
\[\e[32m\]\u@\h\[\e[m\] \
\[\e[33m\]\W\[\e[m\]\
\[\e[31m\]$(__repo_ps1)\[\e[m\]\
]\$ '

# set default editor to notepad++
export EDITOR=$(which nppedit)

# redirect to Documents folder if starting in home
if [ `pwd` == ${HOME} ]; then
	cd ${HOME}/Documents
fi