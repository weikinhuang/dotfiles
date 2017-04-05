# ~/.bashrc: executed by bash(1) for non-login shells.

# If not running interactively, don't do anything
[ -z "$PS1" ] && return

# Force usage of 256 color terminal
case "$TERM" in
	xterm*)
		export TERM="xterm-256color"
		;;
	rxvt*)
		export TERM="rxvt-256color"
		;;
	screen*)
		export TERM="screen-256color"
		;;
	*)
		;;
esac

# Check out which env this bash is running in
DOTENV="linux"
case "$(uname -s)" in
	CYGWIN* )
		DOTENV="cygwin"
		;;
	MINGW32_NT* )
		# we'll just pretend to use the cygwin functions
		DOTENV="cygwin"
		# we can only have monochrome prompts
		_PS1_MONOCHROME=1
		# force the usage of /bin/bash instead of /bin/sh
		if [ $BASH == '/bin/sh' ]; then
			BASH='/bin/bash'
		fi
		;;
	Darwin )
		DOTENV="darwin"
		;;
esac
export DOTENV

# modify path to include useful scripts
[[ "${DOTENV}" == "cygwin" ]] && [[ -d "${HOME}/.dotenv/${DOTENV}/bin.$(uname -m)" ]] && PATH="$PATH:${HOME}/.dotenv/${DOTENV}/bin.$(uname -m)"
[[ -d "${HOME}/.dotenv/${DOTENV}/bin" ]] && PATH="$PATH:${HOME}/.dotenv/${DOTENV}/bin"
[[ -d "${HOME}/.dotenv/bin" ]] && PATH="$PATH:${HOME}/.dotenv/bin"
[[ -d "${HOME}/bin" ]] && PATH="$PATH:${HOME}/bin"

# Remove duplicate entries from PATH and retain the original order
if type nl &> /dev/null; then
	export PATH=$(echo "$PATH" | tr : '\n' | nl | sort -u -k 2,2 | sort -n | cut -f 2- | tr '\n' : | sed -e 's/:$//' -e 's/^://')
fi

# Source ~/.exports, ~/.functions, ~/.aliases, ~/.completion, ~/.extra, ~/.env if they exist
for file in {exports,functions,aliases,completion,extra,env}; do
	[[ -r "${HOME}/.dotenv/${file}" ]] && source "${HOME}/.dotenv/${file}"
	[[ -r "${HOME}/.dotenv/${DOTENV}/${file}" ]] && source "${HOME}/.dotenv/${DOTENV}/${file}"
done
unset file

# add local completion
if [[ -d "${HOME}/.completion.d" ]]; then
    source $HOME/.completion.d/*
fi

# load a local specific sources before the scripts
[[ -r "${HOME}/.bash_local" ]] && source "${HOME}/.bash_local"

# include utility settings file (git PS1, solarized, mysql, etc...)
[[ -r "${HOME}/.dotenv/utility" ]] && source "${HOME}/.dotenv/utility"

# Source ~/.post-local, ~/.prompt if they exist
for file in {post-local,prompt}; do
	[[ -r "${HOME}/.dotenv/${file}" ]] && source "${HOME}/.dotenv/${file}"
	[[ -r "${HOME}/.dotenv/${DOTENV}/${file}" ]] && source "${HOME}/.dotenv/${DOTENV}/${file}"
done
unset file

# set $EDITOR to vi(m) if not already set
[[ -z $EDITOR ]] && EDITOR=$(type vim &> /dev/null && echo vim || echo vi)
export EDITOR=$EDITOR

# write to .bash_history after each command
__push_prompt_command 'history -a'

# Shell Options
# Use case-insensitive filename globbing
shopt -s nocaseglob

# Include . files when globing (ie. mv, cp, etc.)
shopt -s dotglob

# When changing directory small typos can be ignored by bash
shopt -s cdspell

# Append to the Bash history file, rather than overwriting it
shopt -s histappend

# Try to enable some bash 4 functionality
# Attempt to auto cd to a directory
shopt -s autocd 2> /dev/null
# Recursive globbing, e.g. `echo **/*.txt`
shopt -s globstar 2> /dev/null
# If any jobs are running, this causes the exit to be deferred until a second exit is attempted
shopt -s checkjobs 2> /dev/null

# redirect to a starting directory folder if starting in home
[[ "$(pwd)" == "${HOME}" ]] && [[ -n "${START_DIR}" ]] && [[ -e "${START_DIR}" ]] && cd "${START_DIR}"

# exit with a success status code
return 0
