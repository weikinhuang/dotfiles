# shellcheck shell=bash

# @see https://github.com/eza-community/eza
if ! command -v eza &>/dev/null; then
  return
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
