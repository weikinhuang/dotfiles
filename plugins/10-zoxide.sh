# shellcheck shell=bash

# @see https://github.com/ajeetdsouza/zoxide
if ! command -v zoxide &>/dev/null; then
  return
fi

eval "$(zoxide init bash)"
