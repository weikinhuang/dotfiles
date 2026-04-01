# shellcheck shell=bash
# Configure zoxide integration.
# SPDX-License-Identifier: MIT

# @see https://github.com/ajeetdsouza/zoxide
if ! command -v zoxide &>/dev/null; then
  return
fi

internal::cached-eval zoxide "zoxide init bash"
