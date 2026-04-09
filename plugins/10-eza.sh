# shellcheck shell=bash
# Configure eza integration and theme setup.
# SPDX-License-Identifier: MIT

# @see https://github.com/eza-community/eza
if ! command -v eza &>/dev/null; then
  return
fi

# Symlink the appropriate solarized eza theme to ~/.config/eza/theme.yml
# Theme files: config/eza/solarized-{dark,light}.yml
if [[ -n "${DOT_SOLARIZED_LIGHT:-}" ]]; then
  __dot_eza_theme="${DOTFILES__ROOT}/.dotfiles/config/eza/solarized-light.yml"
elif [[ -n "${DOT_SOLARIZED_DARK:-}" ]]; then
  __dot_eza_theme="${DOTFILES__ROOT}/.dotfiles/config/eza/solarized-dark.yml"
else
  __dot_eza_theme=""
fi
if [[ -n "${__dot_eza_theme}" ]] && [[ -f "${__dot_eza_theme}" ]]; then
  mkdir -p "${HOME}/.config/eza"
  if [[ ! -e "${HOME}/.config/eza/theme.yml" ]] || [[ -L "${HOME}/.config/eza/theme.yml" ]]; then
    ln -sf "${__dot_eza_theme}" "${HOME}/.config/eza/theme.yml"
  fi
fi
unset __dot_eza_theme

# Override ls aliases with eza after the default internal::grep-ls-colors runs
function internal::eza-ls-aliases() {
  # Suppressed on WSL (eza omits the hostname from file:// URLs) and over SSH
  # (remote file:// paths are not accessible from the local terminal).
  if [[ -z "${DOT_DISABLE_HYPERLINKS:-}" ]] && [[ -z "${DOT___IS_WSL:-}" ]] && [[ -z "${DOT___IS_SSH:-}" ]]; then
    alias ls="eza --hyperlink"
    alias la="eza -la --group-directories-first --hyperlink"
    alias ll="eza -l --group-directories-first --hyperlink"
    alias l.="eza -d --hyperlink .*"
    alias lt="eza -lT --level=2 --hyperlink"
  else
    alias ls="eza"
    alias la="eza -la --group-directories-first"
    alias ll="eza -l --group-directories-first"
    alias l.="eza -d .*"
    alias lt="eza -lT --level=2"
  fi

  unset -f internal::eza-ls-aliases
}
dotfiles_hook_plugin_post_functions+=(internal::eza-ls-aliases)
