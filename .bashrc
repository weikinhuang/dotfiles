# User dependent .bashrc file

# If not running interactively, don't do anything
[[ "$-" != *i* ]] && return

# Source ~/.exports, ~/.functions, ~/.aliases, ~/.prompt, ~/.extra if they exist
for file in ~/.{exports,functions,aliases,prompt,extra,cygwin}; do
	[ -r "$file" ] && source "$file"
done
unset file

# Shell Options
# Use case-insensitive filename globbing
shopt -s nocaseglob

# When changing directory small typos can be ignored by bash
shopt -s cdspell

# Append to the Bash history file, rather than overwriting it
shopt -s histappend

# Completion options
if [ -f "/etc/bash_completion" ]; then
  source "/etc/bash_completion"
fi
