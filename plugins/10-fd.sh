# shellcheck shell=bash
# Configure fd-find integration.
# SPDX-License-Identifier: MIT

# @see https://github.com/sharkdp/fd
if command -v fd &>/dev/null; then
  DOTFILES__FD_COMMAND="fd"
elif command -v fdfind &>/dev/null; then
  alias fd="fdfind"
  DOTFILES__FD_COMMAND="fdfind"
else
  return
fi

# Suppressed on WSL (fd omits the hostname from file:// URLs) and over SSH
# (remote file:// paths are inaccessible locally).
__dot_fd_hyperlink=""
if [[ -z "${DOT_DISABLE_HYPERLINKS:-}" ]] && [[ -z "${DOT___IS_WSL:-}" ]] \
  && [[ -z "${DOT___IS_SSH:-}" ]] \
  && "${DOTFILES__FD_COMMAND}" -h 2>&1 | command grep -q -- --hyperlink; then
  __dot_fd_hyperlink="--hyperlink"
fi

function findhere() {
  # shellcheck disable=SC2086
  "${DOTFILES__FD_COMMAND}" --hidden --follow ${__dot_fd_hyperlink} "$@"
}
