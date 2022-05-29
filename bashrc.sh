#!/bin/bash
# ~/.bashrc: executed by bash(1) for non-login shells.

# If not running interactively, don't do anything
[[ -z "${PS1}" && -z "${BASHRC_NONINTERACTIVE_BYPASS:-}" ]] && return

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
IS_SCREEN=
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
    elif command -v termux-setup-storage &>/dev/null; then
      IS_TERMUX=1
    fi
    ;;
esac
export DOTENV

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
    IS_SCREEN=1
    ;;
  *) ;;
esac

# check if this is a ssh session
IS_SSH=
# alternate check requires looking up parent pids
if [[ -n "${SSH_CONNECTION:-}" || "$(who am i | cut -f2 -d\( | cut -f1 -d:)" != "" ]]; then
  IS_SSH=1
fi

# modify path to include useful scripts
if [[ -n "${IS_WSL}" ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin.$(uname -m)"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin"
fi
if [[ -n "${IS_WSL2}" ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin.$(uname -m)"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin"
fi
if [[ -n "${IS_TERMUX}" ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/termux/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/termux/bin.$(uname -m)"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/termux/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/termux/bin"
fi
if [[ -n "${TMUX:-}" ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin.$(uname -m)"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin"
fi
if [[ -n "${IS_SCREEN}" ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin.$(uname -m)"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin"
fi
if [[ -n "${IS_SSH}" ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin.$(uname -m)"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin"
fi
[[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin.$(uname -m)"
[[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin"
[[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/bin"
[[ -d "${HOME}/bin" ]] && PATH="${PATH}:${HOME}/bin"

# Remove duplicate entries from PATH and retain the original order
if command -v nl &>/dev/null; then
  PATH=$(echo "${PATH}" | tr : '\n' | nl | sort -u -k 2,2 | sort -n | cut -f 2- | tr '\n' : | sed -e 's/:$//' -e 's/^://')
  export PATH
fi

# Source ~/.exports, ~/.functions, ~/.aliases, ~/.completion, ~/.extra, ~/.env if they exist
for file in {exports,functions,aliases,completion,extra,env}; do
  if [[ "${file}" == "completion" ]] && ! command -v complete &>/dev/null; then
    continue
  fi
  # shellcheck source=/dev/null
  [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/${file}.sh"
  # shellcheck source=/dev/null
  [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/${file}.sh"
  if [[ -n "${IS_WSL}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/${file}.sh"
  fi
  if [[ -n "${IS_WSL2}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/${file}.sh"
  fi
  if [[ -n "${IS_TERMUX}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/termux/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/termux/${file}.sh"
  fi
  if [[ -n "${TMUX:-}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/${file}.sh"
  fi
  if [[ -n "${IS_SCREEN}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/${file}.sh"
  fi
  if [[ -n "${IS_SSH}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/${file}.sh"
  fi
done
unset file

# add local completion
if command -v complete &>/dev/null && [[ -d "${HOME}"/.config/completion.d ]]; then
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
  if [[ -n "${IS_WSL}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/${file}.sh"
  fi
  if [[ -n "${IS_WSL2}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/${file}.sh"
  fi
  if [[ -n "${IS_TERMUX}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/termux/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/termux/${file}.sh"
  fi
  if [[ -n "${TMUX:-}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/${file}.sh"
  fi
  if [[ -n "${IS_SCREEN}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/${file}.sh"
  fi
  if [[ -n "${IS_SSH}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/${file}.sh"
  fi
done
unset file

# load plugin hooks
if [[ -n "${INCLUDE_BUILTIN_PLUGINS:-}" ]]; then
  for f in "${DOTFILES__ROOT}/.dotfiles/plugins"/*.sh; do
    if [[ -e "${f}" ]]; then
      # shellcheck source=/dev/null
      source "$f"
    fi
  done
fi
if [[ -d "${HOME}/.bash_local.d" ]]; then
  for f in "${HOME}/.bash_local.d"/*.sh; do
    if [[ -e "${f}" ]]; then
      # shellcheck source=/dev/null
      source "$f"
    fi
  done
fi
unset INCLUDE_BUILTIN_PLUGINS

# internal prompt command stack to simplify the PROMPT_COMMAND variable
__push_prompt_command '__run_prompt_command'

# write to .bash_history after each command
__push_internal_prompt_command 'history -a'

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

# exit with a success status code
return 0
