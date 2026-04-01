# shellcheck shell=bash
# Configure tmux environment integration.
# SPDX-License-Identifier: MIT

# @see https://github.com/tmux/tmux/wiki
if ! command -v tmux &>/dev/null; then
  return
fi

# reloads env vars from tmux
function internal::tmux-reload-env() {
  # shellcheck disable=SC2046
  eval $(tmux show-env -s)
}
if [[ "${TERM:-}" == screen* || "${TERM:-}" == tmux* ]] && [[ -n "${TMUX:-}" ]]; then
  internal::prompt-action-push 'internal::tmux-reload-env'
fi
