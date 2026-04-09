# shellcheck shell=bash
# Configure fd-find integration.
# SPDX-License-Identifier: MIT

# @see https://github.com/sharkdp/fd
if command -v fd &>/dev/null; then
  DOTFILES__FD_COMMAND="fd"
elif command -v fdfind &>/dev/null; then
  DOTFILES__FD_COMMAND="fdfind"
else
  return
fi

# Check hyperlink support once for both the fd alias and findhere function.
if "${DOTFILES__FD_COMMAND}" -h 2>&1 | command grep -q -- --hyperlink; then
  # shellcheck disable=SC2139
  alias fd="${DOTFILES__FD_COMMAND} --hyperlink=auto"

  # Declare findhere with unconditional hyperlinks unless the user opts out
  # via DOT_DISABLE_HYPERLINKS or the session is over SSH without a
  # vscode-family terminal.  On WSL, fd omits the hostname from file://
  # URLs; pipe through osc8-rewrite to fix them.
  if [[ -z "${DOT_DISABLE_HYPERLINKS:-}" ]] \
    && { [[ -n "${__dot_hyperlink_scheme}" ]] || [[ -z "${DOT___IS_SSH:-}" ]]; }; then
    if [[ -n "${DOT___IS_WSL:-}" ]]; then
      function findhere() {
        internal::osc8-rewrite "${DOTFILES__FD_COMMAND}" --hidden --follow --hyperlink "$@"
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
else
  if [[ "${DOTFILES__FD_COMMAND}" == "fdfind" ]]; then
    alias fd="fdfind"
  fi
  function findhere() {
    "${DOTFILES__FD_COMMAND}" --hidden --follow "$@"
  }
fi
