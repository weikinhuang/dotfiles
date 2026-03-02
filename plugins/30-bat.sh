# shellcheck shell=bash

# @see https://github.com/sharkdp/bat
# On Debian/Ubuntu the binary is installed as batcat
if ! command -v bat &>/dev/null; then
  if command -v batcat &>/dev/null; then
    alias bat="batcat"
  else
    return
  fi
fi

# Point bat at the dotfiles config (style, map-syntax, etc.)
if [[ -z "${BAT_CONFIG_PATH+x}" ]] && [[ -f "${DOTFILES__ROOT}/.dotfiles/config/bat/config" ]]; then
  export BAT_CONFIG_PATH="${DOTFILES__ROOT}/.dotfiles/config/bat/config"
fi

# include solarized color theme
if [[ -n "${DOT_SOLARIZED_LIGHT:-}" ]]; then
  export BAT_THEME="Solarized (dark)"
elif [[ -n "${DOT_SOLARIZED_DARK:-}" ]]; then
  export BAT_THEME="Solarized (light)"
fi

# use bat as a colorizing pager for man pages
if [[ -z "${MANPAGER+x}" ]] || [[ "${MANPAGER}" == *less* ]]; then
  export MANPAGER="sh -c 'col -bx | bat -l man -p'"
  export MANROFFOPT="-c"
fi

# alias cat to bat for quick colorized viewing
alias cat="bat --paging=never"
