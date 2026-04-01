# shellcheck shell=bash
# Configure direnv integration.
# SPDX-License-Identifier: MIT

# @see https://direnv.net/
if ! command -v direnv &>/dev/null; then
  return
fi

export DIRENV_LOG_FORMAT=
internal::cached-eval direnv "direnv hook bash"
