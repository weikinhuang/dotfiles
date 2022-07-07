# shellcheck shell=bash

# helper function to add to path if dir exists, and set by unique value
function __push_path() {
  local prepend=
  local path__tmp="$PATH"
  if [[ "$1" == "--prepend" ]] || [[ "$1" == "-p" ]]; then
    prepend=1
    shift
  fi
  local path="$1"
  if [[ ! -d "${path}" ]]; then
    return
  fi
  if [[ -n "${prepend}" ]]; then
    path__tmp="${path}:${path__tmp}"
  else
    path__tmp="${path__tmp}:${path}"
  fi

  # Remove duplicate entries from PATH and retain the original order
  if command -v nl &>/dev/null; then
    path__tmp="$(
      echo "${path__tmp}" \
        | tr : '\n' \
        | nl \
        | sort -u -k 2,2 \
        | sort -n \
        | cut -f 2- \
        | tr '\n' : \
        | sed -e 's/:$//' -e 's/^://'
    )"
  fi
  PATH="${path__tmp}"
  export PATH
}

# generate paths according to environment
function __dot_path_setup() {
  # modify path to include useful scripts
  if [[ -n "${TMUX:-}" ]]; then
    __push_path --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin"
    __push_path --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin.$(uname -m)"
  fi
  if [[ -n "${DOT___IS_SCREEN}" ]]; then
    __push_path --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin"
    __push_path --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin.$(uname -m)"
  fi
  if [[ -n "${DOT___IS_SSH}" ]]; then
    __push_path --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin"
    __push_path --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin.$(uname -m)"
  fi
  if [[ -n "${DOT___IS_WSL}" ]]; then
    __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin.$(uname -m)"
    __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin"
  fi
  if [[ -n "${DOT___IS_WSL2}" ]]; then
    __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin.$(uname -m)"
    __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin"
  fi
  __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin.$(uname -m)"
  __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin"
  __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/bin.$(uname -m)"
  __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/bin"
  __push_path "${HOME}/bin"

  # python user pip packages
  if command -v python3 &>/dev/null; then
    # optimization, this otherwise takes ~500ms
    # usually ~/.local
    local python_site_path="${HOME}/.local"
    if [[ ! -d "${python_site_path}" ]]; then
      python_site_path="$(python3 -m site --user-base &>/dev/null)"
    fi
    if [[ -n "${python_site_path}" ]] && [[ -d "${python_site_path}/bin" ]]; then
      __push_path "${python_site_path}/bin"
    fi
  fi
}

# clean up vars and functions declared
function __dot_path_cleanup() {
  unset -f __dot_path_setup
  unset -f __dot_path_cleanup
}
