# shellcheck shell=bash

# @see https://git-scm.com/
if ! command -v git &>/dev/null; then
  return
fi

# include git __git_ps1 if not already included elsewhere
if ! command -v __git_ps1 &>/dev/null; then
  # shellcheck source=/dev/null
  source "${DOTFILES__ROOT}/.dotfiles/external/git-prompt.sh"
fi
