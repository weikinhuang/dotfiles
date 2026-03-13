# shellcheck shell=bash
# Configure delta git integration.
# SPDX-License-Identifier: MIT

# @see https://github.com/dandavison/delta
if ! command -v delta &>/dev/null; then
  rm -f "${DOTFILES__CONFIG_DIR}/git-delta.gitconfig"
  return
fi

# Select solarized variant based on DOT_SOLARIZED_* env vars, defaulting to dark
if [[ -n "${DOT_SOLARIZED_LIGHT:-}" ]]; then
  _delta_syntax_theme="Solarized (light)"
  _delta_minus_style='syntax "#fff0f0"'
  _delta_minus_emph_style='syntax "#ffc0c0"'
  _delta_plus_style='syntax "#f0fff0"'
  _delta_plus_emph_style='syntax "#a0e8a0"'
else
  _delta_syntax_theme="Solarized (dark)"
  _delta_minus_style='syntax "#3f1f1f"'
  _delta_minus_emph_style='syntax "#6e2b2b"'
  _delta_plus_style='syntax "#1f3f1f"'
  _delta_plus_emph_style='syntax "#2b5e2b"'
fi

cat >|"${DOTFILES__CONFIG_DIR}/git-delta.gitconfig" <<GITCONFIG
[core]
  pager = delta

[interactive]
  diffFilter = delta --color-only

[delta]
  navigate = true
  true-color = always
  syntax-theme = ${_delta_syntax_theme}
  minus-style = ${_delta_minus_style}
  minus-emph-style = ${_delta_minus_emph_style}
  plus-style = ${_delta_plus_style}
  plus-emph-style = ${_delta_plus_emph_style}

[pager]
  log = delta
  show = delta
  diff = delta
GITCONFIG

unset _delta_syntax_theme _delta_minus_style _delta_minus_emph_style _delta_plus_style _delta_plus_emph_style
