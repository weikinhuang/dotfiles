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

# Declare findhere with the right hyperlink handling baked in at load time.
# Hyperlinks are suppressed over SSH (remote paths are inaccessible locally)
# and when the user opts out via DOT_DISABLE_HYPERLINKS.  On WSL, fd omits the
# hostname from file:// URLs; pipe through osc8-wsl-rewrite to fix them.
if [[ -z "${DOT_DISABLE_HYPERLINKS:-}" ]] && [[ -z "${DOT___IS_SSH:-}" ]] \
  && "${DOTFILES__FD_COMMAND}" -h 2>&1 | command grep -q -- --hyperlink; then
  if [[ -n "${DOT___IS_WSL:-}" ]]; then
    function findhere() {
      internal::osc8-wsl-rewrite "${DOTFILES__FD_COMMAND}" --hidden --follow --hyperlink "$@"
    }
  else
    function findhere() {
      "${DOTFILES__FD_COMMAND}" --hidden --follow --hyperlink "$@"
    }
  fi
else
  function findhere() {
    "${DOTFILES__FD_COMMAND}" --hidden --follow "$@"
  }
fi
