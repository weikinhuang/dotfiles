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
  mkdir -p "${DOTFILES__CONFIG_DIR}/cache"
  SHELL=/bin/bash lesspipe.sh 2>/dev/null >|"$_lesspipe_cache"
fi
# shellcheck source=/dev/null
source "$_lesspipe_cache"
unset _lesspipe_cache
