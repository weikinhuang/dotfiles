# shellcheck shell=bash

# @see https://www.gnu.org/software/coreutils/manual/html_node/dircolors-invocation.html
# @see https://linux.die.net/man/5/dir_colors
if ! command -v dircolors &>/dev/null; then
  return
fi

# include solarized dir colors theme
if [[ -n "${DOT_SOLARIZED_LIGHT:-}" ]]; then
  eval "$(SHELL="$(command -v bash)" dircolors "${DOTFILES__ROOT}/.dotfiles/external/dircolors.solarized.ansi-light")"
elif [[ -n "${DOT_SOLARIZED_DARK:-}" ]]; then
  eval "$(SHELL="$(command -v bash)" dircolors "${DOTFILES__ROOT}/.dotfiles/external/dircolors.solarized.256dark")"
fi
