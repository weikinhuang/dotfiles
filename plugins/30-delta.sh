# shellcheck shell=bash

# @see https://github.com/dandavison/delta
if ! command -v delta &>/dev/null; then
  rm -f "${DOTFILES__CONFIG_DIR}/git-delta.gitconfig"
  return
fi

# Generate a git include config for delta if not already present
if [[ ! -f "${DOTFILES__CONFIG_DIR}/git-delta.gitconfig" ]]; then
  cat > "${DOTFILES__CONFIG_DIR}/git-delta.gitconfig" << 'GITCONFIG'
[core]
  pager = delta

[interactive]
  diffFilter = delta --color-only

[delta]
  navigate = true

[pager]
  log = delta
  show = delta
  diff = delta
GITCONFIG
fi
