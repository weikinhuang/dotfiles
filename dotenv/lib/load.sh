# shellcheck shell=bash

# execute dotfile load hooks
function __dot_load_hook() {
  local type="$1"
  local file="${2//-/_}"
  local DOT_HOOK_NAME DOT_HOOK_TMP hook

  # Add a hook that can be defined in .bash_local to run before/after each phase
  DOT_HOOK_NAME="dotfiles_hook_${file}_${type}_functions"
  # if declared in function format
  if type "dotfiles_hook_${file}_${type}" &>/dev/null; then
    eval "${DOT_HOOK_NAME}+=('dotfiles_hook_${file}_${type}')"
  fi
  # shellcheck disable=SC2125
  DOT_HOOK_TMP=${DOT_HOOK_NAME}[@]
  for hook in "${!DOT_HOOK_TMP}"; do
    { "${hook}"; }
  done
}

# source dotfiles according to environment
function __dot_load() {
  local file="$1"

  # Add a hook that can be defined in .bash_local to run before each phase
  __dot_load_hook pre "${file}"

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
  __dot_load_hook post "${file}"
}

# source plugins
function __dot_load_plugin() {
  local file="$1"
  local DOT_PLUGIN_DISABLE_NAME

  DOT_PLUGIN_DISABLE_NAME="DOT_PLUGIN_DISABLE_$(basename "${file}" | sed 's#.plugin$##; s#.sh$##; s#-#_#g')"
  if [[ -z "${!DOT_PLUGIN_DISABLE_NAME:-}" ]] && [[ -e "${file}" ]]; then
    # shellcheck source=/dev/null
    source "${file}"
  fi
  unset "${DOT_PLUGIN_DISABLE_NAME}"
}

function __dot_load_plugins() {
  local file

  # Add a hook that can be defined in .bash_local to run before each phase
  __dot_load_hook pre plugin

  # load plugins from all directories while respecting filename ordering
  {
    find "${DOTFILES__ROOT}/.dotfiles/plugins" -type f -name '*.sh'
    [[ -d "${HOME}/.bash_local.d" ]] && find "${HOME}/.bash_local.d" -type f -name '*.plugin'
  } \
    | awk -F/ '{ print $NF"|"$0 }' \
    | sort -t"|" -k1 \
    | awk -F"|" '{ print $NF }' \
    | awk 'BEGIN { ORS="\000"; }; { print $0 }' \
    | while IFS= read -r -d '' file; do
        __dot_load_plugin "${file}"
      done

  # Add a hook that can be defined in .bash_local to run after each phase
  __dot_load_hook post plugin
}

# clean up vars and functions declared
function __dot_load_cleanup() {
  unset -f __dot_load_hook
  unset -f __dot_load
  unset -f __dot_load_plugin
  unset -f __dot_load_plugins
  unset -f __dot_load_cleanup
}
