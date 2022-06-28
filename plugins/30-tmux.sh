# shellcheck shell=bash

# @see https://github.com/tmux/tmux/wiki
if ! command -v tmux &>/dev/null; then
  return
fi

# reloads env vars from tmux
function _reload-tmux-env() {
  # shellcheck disable=SC2046
  eval $(tmux show-env -s)
}
if [[ "${TERM:-}" == screen* ]] && [[ -n "${TMUX:-}" ]]; then
  __push_internal_prompt_command '_reload-tmux-env'
fi
