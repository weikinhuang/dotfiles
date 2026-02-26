# shellcheck shell=bash

# @see https://github.com/sharkdp/bat
if ! command -v bat &>/dev/null; then
  return
fi

# include solarized color theme
if [[ -n "${DOT_SOLARIZED_LIGHT:-}" ]]; then
  export BAT_THEME="Solarized (dark)"
elif [[ -n "${DOT_SOLARIZED_DARK:-}" ]]; then
  export BAT_THEME="Solarized (light)"
fi

# show line numbers and git changes, auto-detect header from context
export BAT_STYLE="${BAT_STYLE:-numbers,changes,header}"

# use bat as a colorizing pager for man pages
if [[ -z "${MANPAGER+x}" ]] || [[ "${MANPAGER}" == *less* ]]; then
  export MANPAGER="sh -c 'col -bx | bat -l man -p'"
  export MANROFFOPT="-c"
fi

# alias cat to bat for quick colorized viewing
alias cat="bat --paging=never"
