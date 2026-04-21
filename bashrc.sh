#!/usr/bin/env bash
# Initialize interactive Bash shells and load dotfiles.
# SPDX-License-Identifier: MIT
#
# ~/.bashrc: executed by bash(1) for non-login shells.

# If not running interactively, don't do anything
[[ -z "${PS1}" && -z "${BASHRC_NONINTERACTIVE_BYPASS:-}" ]] && return

# Make sure this is bash that's running and return otherwise.
# Use POSIX syntax for this line:
if [ -z "${BASH_VERSION-}" ]; then
  return 1
fi

# load configuration from installation
if [[ -e "${HOME}/.config/dotfiles/.install" ]]; then
  # shellcheck source=/dev/null
  source "${HOME}/.config/dotfiles/.install"
fi
DOTFILES__ROOT="${DOTFILES__INSTALL_ROOT:-${HOME}}"
readonly DOTFILES__ROOT
export DOTFILES__ROOT

# create the dotfiles config root for plugins that write non-cache files.
# cache subdirectories are still created lazily by the shared cache helper.
DOTFILES__CONFIG_DIR="${XDG_CONFIG_HOME:-"${HOME}/.config"}/dotfiles"
readonly DOTFILES__CONFIG_DIR
export DOTFILES__CONFIG_DIR
if [[ ! -d "${DOTFILES__CONFIG_DIR}" ]]; then
  mkdir -p "${DOTFILES__CONFIG_DIR}"
fi

# Check out which env this bash is running in
DOTENV="linux"
export DOT___IS_WSL=
export DOT___IS_WSL2=
export DOT___IS_SCREEN=
case "$(uname -s)" in
  Darwin)
    DOTENV="darwin"
    ;;
  Linux)
    # need test for wslpath because we could be in a container
    __dot_uname_r="$(uname -r)"
    if [[ "$__dot_uname_r" == *[Mm]icrosoft* ]] && command -v wslpath &>/dev/null; then
      DOT___IS_WSL=1
      if [[ "$__dot_uname_r" == *WSL2* ]]; then
        DOT___IS_WSL2=1
      fi
    fi
    unset __dot_uname_r
    ;;
esac
readonly DOTENV
export DOTENV

DOTFILES__ARCH="$(uname -m)"
readonly DOTFILES__ARCH
export DOTFILES__ARCH

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
    DOT___IS_SCREEN=1
    ;;
  *) ;;
esac

# Advertise truecolor support for terminals known to handle 24-bit color.
# Terminal emulators typically set this, but tmux/screen/SSH can strip it.
if [[ -z "${COLORTERM:-}" ]]; then
  case "${TERM:-}" in
    *-256color | alacritty | xterm-kitty | xterm-ghostty)
      export COLORTERM=truecolor
      ;;
  esac
fi

# check if this is a ssh session
export DOT___IS_SSH=
if [[ -n "${SSH_CONNECTION:-}" ]] || [[ -n "${SSH_TTY:-}" ]] \
  || [[ -n "${SSH_CLIENT:-}" ]]; then
  DOT___IS_SSH=1
fi
readonly DOT___IS_WSL
readonly DOT___IS_WSL2
readonly DOT___IS_SCREEN
readonly DOT___IS_SSH

# These arrays are used to add functions to be run before, or after, prompts.
# they are set higher up in case the dotfiles scripts want to set hooks
# shellcheck disable=SC2034
declare -a precmd_functions
# shellcheck disable=SC2034
declare -a preexec_functions
# shellcheck disable=SC2034
declare -a chpwd_functions
# shellcheck disable=SC2034
declare -a dotfiles_complete_functions

# These arrays are used to add functions to be run before, or after, loading parts of the dotfiles builtin.
for __dot_hook in {exports,functions,aliases,completion,extra,env,prompt,plugin}; do
  declare -a "dotfiles_hook_${__dot_hook}_pre_functions"
  declare -a "dotfiles_hook_${__dot_hook}_post_functions"
done
unset __dot_hook

# modify path to include useful scripts
# shellcheck source=/dev/null
source "${DOTFILES__ROOT}/.dotfiles/dotenv/lib/utils.sh"
# shellcheck source=/dev/null
source "${DOTFILES__ROOT}/.dotfiles/dotenv/lib/prompt.sh"
# shellcheck source=/dev/null
source "${DOTFILES__ROOT}/.dotfiles/dotenv/lib/path.sh"
internal::path-setup
# shellcheck source=/dev/null
source "${DOTFILES__ROOT}/.dotfiles/dotenv/lib/dotfiles.sh"

# load a local specific sources before the scripts
# shellcheck source=/dev/null
[[ -r "${HOME}/.bash_local" ]] && source "${HOME}/.bash_local"
if [[ -d "${HOME}/.bash_local.d" ]]; then
  for __dot_local_file in "${HOME}/.bash_local.d"/*.sh; do
    if [[ -e "${__dot_local_file}" ]]; then
      # shellcheck source=/dev/null
      source "${__dot_local_file}"
    fi
  done
  unset __dot_local_file
fi

# library functions, load after .bash_local, so it can't be overridden
# shellcheck source=/dev/null
source "${DOTFILES__ROOT}/.dotfiles/dotenv/lib/load.sh"

# Source ~/.exports, ~/.functions, ~/.aliases, ~/.completion, ~/.extra, ~/.env if they exist
internal::load-phase exports
internal::load-phase functions
internal::load-phase aliases
internal::load-phase extra
internal::load-phase env

# add completion
if command -v complete &>/dev/null; then
  internal::load-phase completion

  if [[ -d "${HOME}/.config/completion.d" ]]; then
    for __dot_completion_file in "${HOME}"/.config/completion.d/*; do
      [[ -e "${__dot_completion_file}" ]] || continue
      # shellcheck source=/dev/null
      source "${__dot_completion_file}"
    done
    unset __dot_completion_file
  fi
fi

# load plugin hooks
internal::load-plugins

# Source ~/.prompt if they exist
internal::load-phase prompt

for __dot_hook in {exports,functions,aliases,completion,extra,env,prompt,plugin}; do
  unset -f "dotfiles_hook_${__dot_hook}_pre"
  unset -f "dotfiles_hook_${__dot_hook}_post"
  unset "dotfiles_hook_${__dot_hook}_pre_functions"
  unset "dotfiles_hook_${__dot_hook}_post_functions"
done
unset __dot_hook
internal::path-cleanup
internal::load-cleanup

# internal prompt command stack to simplify the PROMPT_COMMAND variable
internal::prompt-command-push 'internal::prompt-action-run'

# write to .bash_history after each command
internal::prompt-action-push 'history -a'

# emulate zsh's hook functions for "precmd" and "preexec"
# see https://github.com/rcaloras/bash-preexec
# see https://zsh.sourceforge.io/Doc/Release/Functions.html#Hook-Functions
if [[ -z "${DOT_DISABLE_PREEXEC:-}" ]]; then
  # shellcheck source=/dev/null
  source "${DOTFILES__ROOT}/.dotfiles/external/bash-preexec.sh"
fi

# Add a hook that can be defined in .bash_local to run after everything is fully loaded
if command -v dotfiles_complete &>/dev/null; then
  dotfiles_complete_functions+=(dotfiles_complete)
fi
# shellcheck disable=SC2125
for __dot_hook in "${dotfiles_complete_functions[@]}"; do
  { "${__dot_hook}"; }
done
unset dotfiles_complete
unset dotfiles_complete_functions
unset __dot_hook

# exit with a success status code
return 0
