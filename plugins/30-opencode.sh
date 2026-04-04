# shellcheck shell=bash
# Configure opencode completion.
# SPDX-License-Identifier: MIT

# @see https://opencode.ai/
if ! command -v opencode &>/dev/null; then
  return
fi

internal::cached-completion opencode "opencode completion"
