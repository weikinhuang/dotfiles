# shellcheck shell=bash

# @see https://github.com/eza-community/eza
if ! command -v eza &>/dev/null; then
  return
fi

# Adjust eza-specific UI element colors for light backgrounds; eza's built-in
# defaults are already readable on dark terminals so we only override for light.
if [[ -z "${EZA_COLORS+x}" ]] && [[ -n "${DOT_SOLARIZED_LIGHT:-}" ]]; then
  export EZA_COLORS="da=36:uu=2;33:un=1;31:gu=2;32:gn=1;35:sn=32:sb=36:xx=2"
fi

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
