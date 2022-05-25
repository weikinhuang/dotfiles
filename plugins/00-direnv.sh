# shellcheck shell=bash

# @see https://direnv.net/
if command -v direnv &>/dev/null; then
  export DIRENV_LOG_FORMAT=
  # shellcheck source=/dev/null
  source <(direnv hook bash 2>/dev/null)
fi
