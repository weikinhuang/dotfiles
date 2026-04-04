# shellcheck shell=bash
# Configure codex completion.
# SPDX-License-Identifier: MIT

# @see https://codex.dev/
if ! command -v codex &>/dev/null; then
  return
fi

internal::cached-completion codex "codex completion"
