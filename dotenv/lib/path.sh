# shellcheck shell=bash

# helper function to add to path if dir exists, with pure-bash deduplication
function __push_path() {
  local prepend=
  if [[ "$1" == "--prepend" ]] || [[ "$1" == "-p" ]]; then
    prepend=1
    shift
  fi
  local path="$1"
  if [[ ! -d "${path}" ]]; then
    return
  fi
  case ":${PATH}:" in
    *:"${path}":*) return ;;
  esac
  if [[ -n "${prepend}" ]]; then
    PATH="${path}:${PATH}"
  else
    PATH="${PATH}:${path}"
  fi
  export PATH
}

# generate paths according to environment
function __dot_path_setup() {
  local _arch
  _arch="$(uname -m)"

  # modify path to include useful scripts
  if [[ -n "${TMUX:-}" ]]; then
    __push_path --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin"
    __push_path --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin.${_arch}"
  fi
  if [[ -n "${DOT___IS_SCREEN}" ]]; then
    __push_path --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin"
    __push_path --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin.${_arch}"
  fi
  if [[ -n "${DOT___IS_SSH}" ]]; then
    __push_path --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin"
    __push_path --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin.${_arch}"
  fi
  if [[ -n "${DOT___IS_WSL}" ]]; then
    __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin.${_arch}"
    __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin"
  fi
  if [[ -n "${DOT___IS_WSL2}" ]]; then
    __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin.${_arch}"
    __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin"
  fi
  __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin.${_arch}"
  __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin"
  __push_path "${DOTFILES__ROOT}/.dotfiles/dotenv/bin.${_arch}"
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
