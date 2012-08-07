# ~/.bashrc: executed by bash(1) for non-login shells.

# If not running interactively, don't do anything
[ -z "$PS1" ] && return

# Check out which env this bash is running in
DOTENV="linux"
case "$(uname -s)" in
    CYGWIN* )
        DOTENV="cygwin"
		;;
    Darwin )
        DOTENV="darwin"
		;;
esac
export DOTENV

# load a local specific sources before the scripts
[ -r "${HOME}/.bash_local_exports" ] && source "${HOME}/.bash_local_exports"

# Completion options
[ -f "/etc/bash_completion" ] && source "/etc/bash_completion"

# Source ~/.exports, ~/.functions, ~/.aliases, ~/.completion, ~/.prompt, ~/.extra, ~/.env if they exist
for file in {exports,functions,aliases,completion,prompt,extra,env}; do
	[ -r "${HOME}/.dotenv/.${file}" ] && source "${HOME}/.dotenv/.${file}"
	[ -r "${HOME}/.dotenv/${DOTENV}/.${file}" ] && source "${HOME}/.dotenv/${DOTENV}/.${file}"
done
unset file

# load a local specific sources before the scripts
[ -r "${HOME}/.bash_local" ] && source "${HOME}/.bash_local"

# modify path to include useful scripts
[ -d "${HOME}/.dotenv/${DOTENV}/bin" ] && PATH="$PATH:${HOME}/.dotenv/${DOTENV}/bin"
[ -d "${HOME}/.dotenv/bin" ] && PATH="$PATH:${HOME}/.dotenv/bin"
[ -d "${HOME}/bin" ] && PATH="$PATH:${HOME}/bin"

# Remove duplicate entries from PATH and retain the original order
export PATH=$(echo "$PATH" | tr : '\n' | nl | sort -u -k 2,2 | sort -n | cut -f 2- | tr '\n' : | sed -e 's/:$//' -e 's/^://')

# include git __git_ps1 if not already included elsewhere
type __git_ps1 &> /dev/null || source "${HOME}/.dotenv/other/git-prompt.sh"

# include solarized dir colors theme
[ -n "$__term_solarized_light" ] && eval "$(dircolors "${HOME}/.dotenv/other/dircolors.solarized.ansi-light")"

# Shell Options
# Use case-insensitive filename globbing
shopt -s nocaseglob

# When changing directory small typos can be ignored by bash
shopt -s cdspell

# Append to the Bash history file, rather than overwriting it
shopt -s histappend

# exit with a success status code
return 0