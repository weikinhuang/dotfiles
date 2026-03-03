# shellcheck shell=bash

# @see https://direnv.net/
if ! command -v direnv &>/dev/null; then
  return
fi

export DIRENV_LOG_FORMAT=
__dot_cached_eval direnv "direnv hook bash"
