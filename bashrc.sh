#!/bin/bash
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

# Check out which env this bash is running in
DOTENV="linux"
IS_WSL=
IS_WSL2=
IS_SCREEN=
case "$(uname -s)" in
  Darwin)
    DOTENV="darwin"
    ;;
  Linux)
    # need test for wslpath because we could be in a container
    if uname -r | grep -qi Microsoft && type wslpath &>/dev/null; then
      IS_WSL=1
      if uname -r | grep -qi WSL2; then
        IS_WSL2=1
      fi
    fi
    ;;
esac
readonly DOTENV
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

# These arrays are used to add functions to be run before, or after, prompts.
# they are set higher up in case the dotfiles scripts want to set hooks
# shellcheck disable=SC2034
declare -a precmd_functions
# shellcheck disable=SC2034
declare -a preexec_functions

# These arrays are used to add functions to be run before, or after, loading parts of the dotfiles builtin.
for hook in {exports,functions,aliases,completion,extra,env,post_local,prompt,plugins}; do
  declare -a "dotfiles_hook_${hook}_pre_functions"
  declare -a "dotfiles_hook_${hook}_post_functions"
done
unset hook

# check if this is a ssh session
IS_SSH=
# alternate check requires looking up parent pids
if [[ -n "${SSH_CONNECTION:-}" || "$(who am i | cut -f2 -d\( | cut -f1 -d:)" != "" ]]; then
  IS_SSH=1
fi

# modify path to include useful scripts
if [[ -n "${TMUX:-}" ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin.$(uname -m)" ]] && PATH="${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin.$(uname -m):${PATH}"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin" ]] && PATH="${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin:${PATH}"
fi
if [[ -n "${IS_SCREEN}" ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin.$(uname -m)" ]] && PATH="${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin.$(uname -m):${PATH}"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin" ]] && PATH="${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin:${PATH}"
fi
if [[ -n "${IS_SSH}" ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin.$(uname -m)" ]] && PATH="${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin.$(uname -m):${PATH}"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin" ]] && PATH="${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin:${PATH}"
fi
if [[ -n "${IS_WSL}" ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin.$(uname -m)"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin"
fi
if [[ -n "${IS_WSL2}" ]]; then
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin.$(uname -m)"
  [[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin"
fi
[[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin.$(uname -m)" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin.$(uname -m)"
[[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin"
[[ -d "${DOTFILES__ROOT}/.dotfiles/dotenv/bin" ]] && PATH="${PATH}:${DOTFILES__ROOT}/.dotfiles/dotenv/bin"
[[ -d "${HOME}/bin" ]] && PATH="${PATH}:${HOME}/bin"
# python user pip packages
if command -v python3 &>/dev/null && python3 -m site --user-base &>/dev/null && [[ -d "$(python3 -m site --user-base)/bin" ]]; then
  # usually ~/.local/bin
  PATH="${PATH}:$(python3 -m site --user-base)/bin"
fi

# Remove duplicate entries from PATH and retain the original order
if command -v nl &>/dev/null; then
  PATH=$(echo "${PATH}" | tr : '\n' | nl | sort -u -k 2,2 | sort -n | cut -f 2- | tr '\n' : | sed -e 's/:$//' -e 's/^://')
  export PATH
fi

# load a local specific sources before the scripts
# shellcheck source=/dev/null
[[ -r "${HOME}/.bash_local" ]] && source "${HOME}/.bash_local"
if [[ -d "${HOME}/.bash_local.d" ]]; then
  for f in "${HOME}/.bash_local.d"/*.sh; do
    if [[ -e "${f}" ]]; then
      # shellcheck source=/dev/null
      source "${f}"
    fi
  done
  unset f
fi

# library functions, load after .bash_local, so it can't be overridden
# shellcheck source=/dev/null
source "${DOTFILES__ROOT}/.dotfiles/dotenv/lib/"*.sh

# Source ~/.exports, ~/.functions, ~/.aliases, ~/.completion, ~/.extra, ~/.env if they exist
__dot_load exports
__dot_load functions
__dot_load aliases
__dot_load extra
__dot_load env

# add completion
if command -v complete &>/dev/null; then
  __dot_load completion

  if [[ -d "${HOME}"/.config/completion.d ]]; then
    # shellcheck source=/dev/null
    source "${HOME}"/.config/completion.d/* || true
  fi
fi

# include utility settings file (git PS1, solarized, mysql, etc...)
# shellcheck source=/dev/null
[[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/utility.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/utility.sh"

# load plugin hooks
if [[ -n "${DOT_INCLUDE_BUILTIN_PLUGINS:-}" ]]; then
  __dot_load_plugins
fi
unset DOT_INCLUDE_BUILTIN_PLUGINS

# Source ~/.prompt if they exist
__dot_load prompt

for hook in {exports,functions,aliases,completion,extra,env,post_local,prompt,plugins}; do
  unset -f "dotfiles_hook_${hook}_pre"
  unset -f "dotfiles_hook_${hook}_post"
  unset "dotfiles_hook_${hook}_pre_functions"
  unset "dotfiles_hook_${hook}_post_functions"
done
unset hook
__dot_load_cleanup

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

# emulate zsh's hook functions for "precmd" and "preexec"
# see https://github.com/rcaloras/bash-preexec
# see https://zsh.sourceforge.io/Doc/Release/Functions.html#Hook-Functions
if [[ -z "${DOT_DISABLE_PREEXEC:-}" ]]; then
  # shellcheck source=/dev/null
  source "${DOTFILES__ROOT}/.dotfiles/external/bash-preexec.sh"
fi

# Add a hook that can be defined in .bash_local to run after everything is fully loaded
if type dotfiles_complete &>/dev/null; then
  { dotfiles_complete; }
  unset -f dotfiles_complete
fi

# exit with a success status code
return 0
