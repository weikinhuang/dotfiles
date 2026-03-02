# shellcheck shell=bash

# @see https://github.com/eza-community/eza
if ! command -v eza &>/dev/null; then
  return
fi

# Symlink the appropriate solarized eza theme to ~/.config/eza/theme.yml
# Theme files: config/eza/solarized-{dark,light}.yml
if [[ -n "${DOT_SOLARIZED_LIGHT:-}" ]]; then
  _eza_theme="${DOTFILES__ROOT}/.dotfiles/config/eza/solarized-light.yml"
elif [[ -n "${DOT_SOLARIZED_DARK:-}" ]]; then
  _eza_theme="${DOTFILES__ROOT}/.dotfiles/config/eza/solarized-dark.yml"
else
  _eza_theme=""
fi
if [[ -n "${_eza_theme}" ]] && [[ -f "${_eza_theme}" ]]; then
  mkdir -p "${HOME}/.config/eza"
  if [[ ! -e "${HOME}/.config/eza/theme.yml" ]] || [[ -L "${HOME}/.config/eza/theme.yml" ]]; then
    ln -sf "${_eza_theme}" "${HOME}/.config/eza/theme.yml"
  fi
fi
unset _eza_theme

# Override ls aliases with eza after the default __grep_ls_colors runs
function __eza_ls_aliases() {
  alias ls="eza"
  alias la="eza -la --group-directories-first"
  alias ll="eza -l --group-directories-first"
  alias l.="eza -d .*"
  alias lt="eza -lT --level=2"

  unset -f __eza_ls_aliases
}
dotfiles_hook_plugin_post_functions+=(__eza_ls_aliases)
