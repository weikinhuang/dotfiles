# shellcheck shell=bash
# Configure ripgrep defaults.
# SPDX-License-Identifier: MIT

# @see https://github.com/BurntSushi/ripgrep
if ! command -v rg &>/dev/null; then
  return
fi

# Point ripgrep at the dotfiles config
if [[ -z "${RIPGREP_CONFIG_PATH+x}" ]] && [[ -f "${DOTFILES__ROOT}/.dotfiles/config/ripgrep/config" ]]; then
  export RIPGREP_CONFIG_PATH="${DOTFILES__ROOT}/.dotfiles/config/ripgrep/config"
fi
