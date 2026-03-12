# shellcheck shell=bash
# Configure GitHub CLI completion.
# SPDX-License-Identifier: MIT

# @see https://cli.github.com/
if ! command -v gh &>/dev/null; then
  return
fi

__dot_cached_completion gh "gh completion -s bash"
