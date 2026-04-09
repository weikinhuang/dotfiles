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
  __dot_delta_syntax_theme="Solarized (light)"
  __dot_delta_minus_style='syntax "#fff0f0"'
  __dot_delta_minus_emph_style='syntax "#ffc0c0"'
  __dot_delta_plus_style='syntax "#f0fff0"'
  __dot_delta_plus_emph_style='syntax "#a0e8a0"'
else
  __dot_delta_syntax_theme="Solarized (dark)"
  __dot_delta_minus_style='syntax "#3f1f1f"'
  __dot_delta_minus_emph_style='syntax "#6e2b2b"'
  __dot_delta_plus_style='syntax "#1f3f1f"'
  __dot_delta_plus_emph_style='syntax "#2b5e2b"'
fi

if [[ -n "${DOT_DISABLE_HYPERLINKS:-}" ]] \
  || { [[ -z "${__dot_hyperlink_scheme}" ]] && [[ -n "${DOT___IS_SSH:-}" ]]; }; then
  __dot_delta_hyperlinks="false"
  __dot_delta_hyperlink_format=""
elif [[ -n "${DOT___IS_WSL:-}" ]] && [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  # delta defaults to file://{path} (no hostname); on WSL this breaks because
  # Windows apps cannot resolve bare Unix paths to the WSL filesystem.
  __dot_delta_hyperlinks="true"
  __dot_delta_hyperlink_format="file://wsl.localhost/${WSL_DISTRO_NAME}{path}#{line}"
else
  __dot_delta_hyperlinks="true"
  __dot_delta_hyperlink_format=""
fi

cat >|"${DOTFILES__CONFIG_DIR}/git-delta.gitconfig" <<GITCONFIG
[core]
  pager = delta

[interactive]
  diffFilter = delta --color-only

[delta]
  navigate = true
  true-color = always
  hyperlinks = ${__dot_delta_hyperlinks}${__dot_delta_hyperlink_format:+
  hyperlinks-file-link-format = ${__dot_delta_hyperlink_format}}
  syntax-theme = ${__dot_delta_syntax_theme}
  minus-style = ${__dot_delta_minus_style}
  minus-emph-style = ${__dot_delta_minus_emph_style}
  plus-style = ${__dot_delta_plus_style}
  plus-emph-style = ${__dot_delta_plus_emph_style}

[pager]
  log = delta
  show = delta
  diff = delta
GITCONFIG

unset __dot_delta_syntax_theme __dot_delta_minus_style __dot_delta_minus_emph_style __dot_delta_plus_style __dot_delta_plus_emph_style __dot_delta_hyperlinks __dot_delta_hyperlink_format
