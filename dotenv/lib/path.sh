# shellcheck shell=bash
# Provide PATH helper functions for the dotfiles loader.
# SPDX-License-Identifier: MIT

# helper function to add to path if dir exists, with pure-bash deduplication
function internal::path-push() {
  local prepend=
  if [[ "$1" == "--prepend" ]] || [[ "$1" == "-p" ]]; then
    prepend=1
    shift
  fi
  local path="${1%/}"
  [[ -z "$path" ]] && path="/"
  if [[ ! -d "${path}" ]]; then
    return
  fi
  case ":${PATH}:" in
    *:"${path}":* | *:"${path}/":*) return ;;
  esac
  if [[ -n "${prepend}" ]]; then
    PATH="${path}:${PATH}"
  else
    PATH="${PATH}:${path}"
  fi
  export PATH
}

# remove duplicate PATH entries and normalize trailing slashes
function internal::path-dedup() {
  local result="" rest="$PATH" entry key
  local seen=":"
  while [[ -n "$rest" ]]; do
    entry="${rest%%:*}"
    if [[ "$rest" == *:* ]]; then
      rest="${rest#*:}"
    else
      rest=""
    fi
    [[ -z "$entry" ]] && continue
    key="${entry%/}"
    [[ -z "$key" ]] && key="/"
    [[ "$seen" == *:"${key}":* ]] && continue
    seen="${seen}${key}:"
    result="${result:+${result}:}${key}"
  done
  PATH="${result}"
  export PATH
}

# generate paths according to environment
function internal::path-setup() {
  local arch
  arch="${DOTFILES__ARCH:-$(uname -m)}"

  # modify path to include useful scripts
  if [[ -n "${TMUX:-}" ]]; then
    internal::path-push --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin"
    internal::path-push --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/tmux/bin.${arch}"
  fi
  if [[ -n "${DOT___IS_SCREEN}" ]]; then
    internal::path-push --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin"
    internal::path-push --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/screen/bin.${arch}"
  fi
  if [[ -n "${DOT___IS_SSH}" ]]; then
    internal::path-push --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin"
    internal::path-push --prepend "${DOTFILES__ROOT}/.dotfiles/dotenv/ssh/bin.${arch}"
  fi
  if [[ -n "${DOT___IS_WSL}" ]]; then
    internal::path-push "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin.${arch}"
    internal::path-push "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/bin"
  fi
  if [[ -n "${DOT___IS_WSL2}" ]]; then
    internal::path-push "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin.${arch}"
    internal::path-push "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl2/bin"
  fi
  internal::path-push "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin.${arch}"
  internal::path-push "${DOTFILES__ROOT}/.dotfiles/dotenv/${DOTENV}/bin"
  internal::path-push "${DOTFILES__ROOT}/.dotfiles/dotenv/bin.${arch}"
  internal::path-push "${DOTFILES__ROOT}/.dotfiles/dotenv/bin"
  internal::path-push "${HOME}/bin"

  # python user pip packages
  if command -v python3 &>/dev/null; then
    # optimization, this otherwise takes ~500ms
    # usually ~/.local
    local python_site_path="${HOME}/.local"
    if [[ ! -d "${python_site_path}" ]]; then
      python_site_path="$(python3 -m site --user-base 2>/dev/null || true)"
    fi
    if [[ -n "${python_site_path}" ]] && [[ -d "${python_site_path}/bin" ]]; then
      internal::path-push "${python_site_path}/bin"
    fi
  fi
}

# clean up vars and functions declared
function internal::path-cleanup() {
  internal::path-dedup
  unset -f internal::path-setup
  unset -f internal::path-cleanup
}
