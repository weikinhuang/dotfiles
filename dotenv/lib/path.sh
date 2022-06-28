# shellcheck shell=bash

function __dot_prepend_path() {
  local path="$1"
  if [[ -d "${path}" ]]; then
    PATH="${path}:${PATH}"
  fi
}

function __dot_append_path() {
  local path="$1"
  if [[ -d "${path}" ]]; then
    PATH="${PATH}:${path}"
  fi
}

# generate paths according to environment
function __dot_path_setup() {
  # modify path to include useful scripts
  if [[ -n "${TMUX:-}" ]]; then
    __dot_prepend_path "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin"
    __dot_prepend_path "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin.$(uname -m)"
  fi
  if [[ -n "${DOT___IS_SCREEN}" ]]; then
    __dot_prepend_path "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin"
    __dot_prepend_path "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin.$(uname -m)"
  fi
  if [[ -n "${DOT___IS_SSH}" ]]; then
    __dot_prepend_path "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin"
    __dot_prepend_path "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin.$(uname -m)"
  fi
  if [[ -n "${DOT___IS_WSL}" ]]; then
    __dot_append_path "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin.$(uname -m)"
    __dot_append_path "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin"
  fi
  if [[ -n "${DOT___IS_WSL2}" ]]; then
    __dot_append_path "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin.$(uname -m)"
    __dot_append_path "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin"
  fi
  __dot_append_path "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin.$(uname -m)"
  __dot_append_path "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin"
  __dot_append_path "${DOTFILES__ROOT}/.dotfiles/dotenv/bin.$(uname -m)"
  __dot_append_path "${DOTFILES__ROOT}/.dotfiles/dotenv/bin"
  __dot_append_path "${HOME}/bin"

  # python user pip packages
  if command -v python3 &>/dev/null && python3 -m site --user-base &>/dev/null; then
    # usually ~/.local/bin
    __dot_append_path "$(python3 -m site --user-base)/bin"
  fi

  # Remove duplicate entries from PATH and retain the original order
  if command -v nl &>/dev/null; then
    PATH=$(echo "${PATH}" | tr : '\n' | nl | sort -u -k 2,2 | sort -n | cut -f 2- | tr '\n' : | sed -e 's/:$//' -e 's/^://')
    export PATH
  fi
}

# clean up vars and functions declared
function __dot_path_cleanup() {
  unset -f __dot_prepend_path
  unset -f __dot_append_path
  unset -f __dot_path_setup
  unset -f __dot_path_cleanup
}
