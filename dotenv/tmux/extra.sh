# shellcheck shell=bash
# Configure tmux-specific shell integration.
# SPDX-License-Identifier: MIT

internal::prompt-action-push 'internal::tmux-sync-powerline-pwd'
internal::tmux-sync-powerline-pwd
internal::prompt-action-push 'internal::tmux-reload-env'
