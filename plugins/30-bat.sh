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

# improve syntax detection for common config files
export BAT_OPTS="${BAT_OPTS:-} --map-syntax='*.conf:INI' --map-syntax='.ignore:Git Ignore' --map-syntax='.gitignore:Git Ignore'"

# alias cat to bat for quick colorized viewing
alias cat="bat --paging=never"
