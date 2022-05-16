# shellcheck shell=bash
# Completion options
if command -v brew &>/dev/null && [[ -f "$(brew --prefix)/etc/bash_completion" ]]; then
  # shellcheck source=/dev/null
  source "$(brew --prefix)/etc/bash_completion"
fi
