# shellcheck shell=bash
# Load dotfiles phases, hooks, and platform-specific files.
# SPDX-License-Identifier: MIT

# execute dotfile load hooks
function internal::load-hook-run() {
  local type="$1"
  local file="${2//-/_}"
  local hook_array_name hook_array_ref hook

  # Add a hook that can be defined in .bash_local to run before/after each phase
  hook_array_name="dotfiles_hook_${file}_${type}_functions"
  # if declared in function format
  if command -v "dotfiles_hook_${file}_${type}" &>/dev/null; then
    eval "${hook_array_name}+=('dotfiles_hook_${file}_${type}')"
  fi
  # shellcheck disable=SC2125
  hook_array_ref=${hook_array_name}[@]
  for hook in "${!hook_array_ref}"; do
    { "${hook}"; }
  done
}

# source dotfiles according to environment
function internal::load-phase() {
  local file="$1"

  # Add a hook that can be defined in .bash_local to run before each phase
  internal::load-hook-run pre "${file}"

  # shellcheck source=/dev/null
  [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/${file}.sh"
  # shellcheck source=/dev/null
  [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/${file}.sh"
  if [[ -n "${DOT___IS_WSL}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/${file}.sh"
  fi
  if [[ -n "${DOT___IS_WSL2}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/${file}.sh"
  fi
  if [[ -n "${TMUX:-}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/${file}.sh"
  fi
  if [[ -n "${DOT___IS_SCREEN}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/${file}.sh"
  fi
  if [[ -n "${DOT___IS_SSH}" ]]; then
    # shellcheck source=/dev/null
    [[ -r "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/${file}.sh" ]] && source "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/${file}.sh"
  fi
  # shellcheck source=/dev/null
  [[ -r "${HOME}/.${file}" ]] && source "${HOME}/.${file}"

  # Add a hook that can be defined in .bash_local to run after each phase
  internal::load-hook-run post "${file}"
}

# source plugins
function internal::load-plugin() {
  local file="$1"
  local plugin_disable_name
  local name="${file##*/}"

  name="${name%.plugin}"
  name="${name%.sh}"
  if [[ "${name}" =~ ^[0-9]+[-_](.+)$ ]]; then
    name="${BASH_REMATCH[1]}"
  fi
  name="${name//[^[:alnum:]_]/_}"
  plugin_disable_name="DOT_PLUGIN_DISABLE_${name}"

  if [[ -z "${!plugin_disable_name:-}" ]] && [[ -e "${file}" ]]; then
    # shellcheck source=/dev/null
    source "${file}"
  fi
  unset "${plugin_disable_name}"
}

function internal::load-plugins() {
  local file
  local -a tagged=()

  internal::load-hook-run pre plugin

  # bash globs return sorted results; tag each with basename for cross-dir sorting
  if [[ -n "${DOT_INCLUDE_BUILTIN_PLUGINS:-}" ]]; then
    for file in "${DOTFILES__ROOT}/.dotfiles/plugins/"*.sh; do
      [[ -e "$file" ]] || continue
      tagged+=("${file##*/}|${file}")
    done
  else
    tagged+=("00-bash-opts.sh|${DOTFILES__ROOT}/.dotfiles/plugins/00-bash-opts.sh")
    tagged+=("00-chpwd-hook.sh|${DOTFILES__ROOT}/.dotfiles/plugins/00-chpwd-hook.sh")
  fi

  if [[ -d "${HOME}/.bash_local.d" ]]; then
    for file in "${HOME}/.bash_local.d/"*.plugin; do
      [[ -e "$file" ]] || continue
      tagged+=("${file##*/}|${file}")
    done
  fi

  # Load plugins; sort only needed to interleave multiple directories.
  # Read from fd 3 so sourced plugins keep stdin attached to the terminal.
  if ((${#tagged[@]})) && [[ "${tagged[*]}" == *".bash_local.d/"* ]]; then
    while IFS= read -r -u 3 file; do
      internal::load-plugin "${file#*|}"
    done 3< <(printf '%s\n' "${tagged[@]}" | sort -t'|' -k1,1)
  else
    for file in "${tagged[@]}"; do
      internal::load-plugin "${file#*|}"
    done
  fi

  internal::load-hook-run post plugin

  unset DOT_INCLUDE_BUILTIN_PLUGINS
}

# clean up vars and functions declared
function internal::load-cleanup() {
  unset -f internal::load-hook-run
  unset -f internal::load-phase
  unset -f internal::load-plugin
  unset -f internal::load-plugins
  unset -f internal::load-cleanup
}
