# shellcheck shell=bash
# Completion options
if type brew &>/dev/null && [[ -f "$(brew --prefix)/etc/bash_completion" ]]; then
  # shellcheck source=/dev/null
  source "$(brew --prefix)/etc/bash_completion"
fi
