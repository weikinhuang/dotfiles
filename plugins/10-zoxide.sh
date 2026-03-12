# shellcheck shell=bash
# Configure zoxide integration.
# SPDX-License-Identifier: MIT

# @see https://github.com/ajeetdsouza/zoxide
if ! command -v zoxide &>/dev/null; then
  return
fi

__dot_cached_eval zoxide "zoxide init bash"
