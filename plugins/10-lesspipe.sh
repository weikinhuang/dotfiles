# shellcheck shell=bash
# Configure lesspipe integration.
# SPDX-License-Identifier: MIT

# @see https://github.com/wofr06/lesspipe
if ! command -v lesspipe.sh &>/dev/null; then
  return
fi

_lesspipe_cache="${DOTFILES__CONFIG_DIR}/cache/lesspipe.bash"
if [[ ! -f "$_lesspipe_cache" ]] \
  || [[ "$(command -v lesspipe.sh)" -nt "$_lesspipe_cache" ]]; then
  __dot_cache_write_atomic "$_lesspipe_cache" "SHELL=/bin/bash lesspipe.sh"
fi
if [[ -f "$_lesspipe_cache" ]]; then
  # shellcheck source=/dev/null
  source "$_lesspipe_cache"
fi
unset _lesspipe_cache
