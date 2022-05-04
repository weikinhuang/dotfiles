#!/bin/bash
# ~/.bashrc: executed by bash(1) for non-login shells.

# If not running interactively, don't do anything
[[ -z "${PS1}" && -z "${BASHRC_NONINTERACTIVE_BYPASS:-}" ]] && return

# Force usage of 256 color terminal
case "${TERM:-xterm}" in
  xterm*)
    export TERM="xterm-256color"
    ;;
  rxvt*)
    export TERM="rxvt-256color"
    ;;
  screen*)
    export TERM="screen-256color"
    ;;
  *) ;;

esac

# load configuration from installation
if [[ -e "${HOME}/.config/dotfiles/.install" ]]; then
  # shellcheck source=/dev/null
  source "${HOME}/.config/dotfiles/.install"
fi
DOTFILES__ROOT="${DOTFILES__INSTALL_ROOT:-${HOME}}"
readonly DOTFILES__ROOT

# Check out which env this bash is running in
DOTENV="linux"
IS_WSL=
IS_WSL2=
IS_TERMUX=
case "$(uname -s)" in
  Darwin)
    DOTENV="darwin"
    ;;
  Linux)
    if uname -r | grep -qi Microsoft; then
      IS_WSL=1
      if uname -r | grep -qi WSL2; then
        IS_WSL2=1
      fi
    elif type termux-setup-storage &>/dev/null; then
      IS_TERMUX=1
    fi
    ;;
esac
export DOTENV

# modify path to include useful scripts
if [[ ${IS_WSL} == 1 ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin.$(uname -m)"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin"
fi
if [[ ${IS_WSL2} == 1 ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin.$(uname -m)"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin"
fi
if [[ ${IS_TERMUX} == 1 ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/termux/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/termux/bin.$(uname -m)"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/termux/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/termux/bin"
fi
[[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin.$(uname -m)"
[[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin"
[[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/bin"
[[ -d "${HOME}/bin" ]] && PATH="${PATH}:${HOME}/bin"

# Remove duplicate entries from PATH and retain the original order
if type nl &>/dev/null; then
  PATH=$(echo "${PATH}" | tr : '\n' | nl | sort -u -k 2,2 | sort -n | cut -f 2- | tr '\n' : | sed -e 's/:$//' -e 's/^://')
  export PATH
fi

# Source ~/.exports, ~/.functions, ~/.aliases, ~/.completion, ~/.extra, ~/.env if they exist
for file in {exports,functions,aliases,completion,extra,env}; do
  # shellcheck source=/dev/null
  [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/${file}.sh"
  # shellcheck source=/dev/null
  [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/${file}.sh"
  if [[ ${IS_WSL} == 1 ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/${file}.sh"
  fi
  if [[ ${IS_WSL2} == 1 ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/${file}.sh"
  fi
  if [[ ${IS_TERMUX} == 1 ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/termux/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/termux/${file}.sh"
  fi
done
unset file

# add local completion
if [[ -d "${HOME}"/.config/completion.d ]]; then
  # shellcheck source=/dev/null
  source "${HOME}"/.config/completion.d/* || true
fi

# load a local specific sources before the scripts
# shellcheck source=/dev/null
[[ -r "${HOME}/.bash_local" ]] && source "${HOME}/.bash_local"

# include utility settings file (git PS1, solarized, mysql, etc...)
# shellcheck source=/dev/null
[[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/utility.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/utility.sh"

# Source ~/.post-local, ~/.prompt if they exist
for file in {post-local,prompt}; do
  # shellcheck source=/dev/null
  [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/${file}.sh"
  # shellcheck source=/dev/null
  [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/${file}.sh"
  if [[ ${IS_WSL} == 1 ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/${file}.sh"
  fi
  if [[ ${IS_WSL2} == 1 ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/${file}.sh"
  fi
  if [[ ${IS_TERMUX} == 1 ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/termux/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/termux/${file}.sh"
  fi
done
unset file

# internal prompt command stack to simplify the PROMPT_COMMAND variable
__push_prompt_command '__run_prompt_command'

# write to .bash_history after each command
__push_internal_prompt_command 'history -a'

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
shopt -s autocd 2>/dev/null
# Recursive globbing, e.g. `echo **/*.txt`
shopt -s globstar 2>/dev/null
# If any jobs are running, this causes the exit to be deferred until a second exit is attempted
shopt -s checkjobs 2>/dev/null

# check the window size after each command and, if necessary,
# update the values of LINES and COLUMNS.
shopt -s checkwinsize

# redirect to a starting directory folder if starting in home
if [[ "$(pwd)" == "${HOME}" ]] && [[ -n "${START_DIR}" && -e "${START_DIR}" ]]; then
  cd "${START_DIR}" || true
fi

# exit with a success status code
return 0
