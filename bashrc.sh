#!/usr/bin/env bash
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
export DOT___IS_WSL=
export DOT___IS_WSL2=
export DOT___IS_SCREEN=
case "$(uname -s)" in
  Darwin)
    DOTENV="darwin"
    ;;
  Linux)
    # need test for wslpath because we could be in a container
    if uname -r | grep -qi Microsoft && type wslpath &>/dev/null; then
      DOT___IS_WSL=1
      if uname -r | grep -qi WSL2; then
        DOT___IS_WSL2=1
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
    DOT___IS_SCREEN=1
    ;;
  *) ;;
esac

# check if this is a ssh session
export DOT___IS_SSH=
# alternate check requires looking up parent pids
# `who` command found in `coreutils`
if [[ -n "${SSH_CONNECTION:-}" ]] || (command -v who &>/dev/null && [[ "$(who am i | cut -f2 -d\( | cut -f1 -d:)" != "" ]]); then
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

# These arrays are used to add functions to be run before, or after, loading parts of the dotfiles builtin.
for hook in {exports,functions,aliases,completion,extra,env,prompt,plugins}; do
  declare -a "dotfiles_hook_${hook}_pre_functions"
  declare -a "dotfiles_hook_${hook}_post_functions"
done
unset hook

# modify path to include useful scripts
# shellcheck source=/dev/null
source "${DOTFILES__ROOT}/.dotfiles/dotenv/lib/path.sh"
__dot_path_setup

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
source "${DOTFILES__ROOT}/.dotfiles/dotenv/lib/load.sh"

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

# load plugin hooks
if [[ -n "${DOT_INCLUDE_BUILTIN_PLUGINS:-}" ]]; then
  __dot_load_plugins
else
  # load required plugins
  # shellcheck source=/dev/null
  source "${DOTFILES__ROOT}/.dotfiles/plugins/00-bash-opts.sh"
  # shellcheck source=/dev/null
  source "${DOTFILES__ROOT}/.dotfiles/plugins/00-chpwd-hook.sh"
fi
unset DOT_INCLUDE_BUILTIN_PLUGINS

# Source ~/.prompt if they exist
__dot_load prompt

for hook in {exports,functions,aliases,completion,extra,env,prompt,plugins}; do
  unset -f "dotfiles_hook_${hook}_pre"
  unset -f "dotfiles_hook_${hook}_post"
  unset "dotfiles_hook_${hook}_pre_functions"
  unset "dotfiles_hook_${hook}_post_functions"
done
unset hook
__dot_path_cleanup
__dot_load_cleanup

# internal prompt command stack to simplify the PROMPT_COMMAND variable
__push_prompt_command '__run_prompt_command'

# write to .bash_history after each command
__push_internal_prompt_command 'history -a'

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
