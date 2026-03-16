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

function findhere() {
  "${DOTFILES__FD_COMMAND}" --hidden --follow "$@"
}
