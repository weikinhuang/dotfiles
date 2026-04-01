# shellcheck shell=bash
# Configure lesspipe integration.
# SPDX-License-Identifier: MIT

# @see https://github.com/wofr06/lesspipe
if ! command -v lesspipe.sh &>/dev/null; then
  return
fi

__dot_lesspipe_cache="${DOTFILES__CONFIG_DIR}/cache/lesspipe.bash"
if [[ ! -f "${__dot_lesspipe_cache}" ]] \
  || [[ "$(command -v lesspipe.sh)" -nt "${__dot_lesspipe_cache}" ]]; then
  internal::cache-write-atomic "${__dot_lesspipe_cache}" "SHELL=/bin/bash lesspipe.sh"
fi
if [[ -f "${__dot_lesspipe_cache}" ]]; then
  # shellcheck source=/dev/null
  source "${__dot_lesspipe_cache}"
fi
unset __dot_lesspipe_cache
