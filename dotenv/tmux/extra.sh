# shellcheck shell=bash
# Configure tmux-specific shell integration.
# SPDX-License-Identifier: MIT

# Reload exported tmux environment variables into the shell.
function internal::tmux-reload-env() {
  # shellcheck disable=SC2046
  eval $(tmux show-env -s)
}

function internal::tmux-pane-id() {
  local pane_id="${TMUX_PANE:-}"

  if [[ -z "${pane_id}" ]]; then
    pane_id="$(tmux display-message -p '#D' 2>/dev/null)" || return 0
  fi

  pane_id="${pane_id//[% ]/}"
  [[ -n "${pane_id}" ]] || return 0
  printf '%s\n' "${pane_id}"
}

function internal::tmux-sync-powerline-pwd() {
  local pane_id
  pane_id="$(internal::tmux-pane-id)"
  [[ -n "${pane_id}" ]] || return 0

  local sync_key="${pane_id}:${PWD}"
  if [[ "${__dot_tmux_powerline_pwd:-}" == "${sync_key}" ]]; then
    return 0
  fi
  __dot_tmux_powerline_pwd="${sync_key}"

  tmux setenv -g "TMUX_PWD_${pane_id}" "${PWD}"
  tmux refresh -S >/dev/null 2>&1 || true
}

if [[ "${TERM:-}" == screen* || "${TERM:-}" == tmux* ]] && [[ -n "${TMUX:-}" ]]; then
  internal::prompt-action-push 'internal::tmux-sync-powerline-pwd'
  internal::tmux-sync-powerline-pwd
  internal::prompt-action-push 'internal::tmux-reload-env'
fi
