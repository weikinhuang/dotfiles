# shellcheck shell=bash

# @see https://github.com/wofr06/lesspipe
if ! command -v lesspipe &>/dev/null; then
  return
fi

# shellcheck source=/dev/null
source <(SHELL=/bin/bash lesspipe 2>/dev/null)
