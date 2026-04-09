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

# The config file enables --hyperlink-format=default; override when the
# file:// URLs would be unusable: SSH without a vscode-family terminal
# (remote paths are inaccessible), WSL (default uses {host} which gives the
# Linux hostname, not the wsl$ UNC path), or user opt-out.
if [[ -n "${DOT_DISABLE_HYPERLINKS:-}" ]]; then
  alias rg='rg --hyperlink-format=none'
elif [[ -n "${DOT___IS_SSH:-}" ]] && [[ -z "${__dot_hyperlink_scheme}" ]]; then
  alias rg='rg --hyperlink-format=none'
elif [[ -n "${DOT___IS_WSL:-}" ]]; then
  alias rg='rg --hyperlink-format=file://{wslprefix}{path}'
fi
