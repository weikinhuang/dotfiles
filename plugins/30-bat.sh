# shellcheck shell=bash

# @see hhttps://github.com/sharkdp/bat
if ! command -v bat &>/dev/null; then
  return
fi

# include solarized color theme
if [[ -n "${DOT_SOLARIZED_LIGHT:-}" ]]; then
  export BAT_THEME="Solarized (dark)"
elif [[ -n "${DOT_SOLARIZED_DARK:-}" ]]; then
  export BAT_THEME="Solarized (light)"
fi
