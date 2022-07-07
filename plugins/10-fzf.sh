# shellcheck shell=bash

# @see https://github.com/junegunn/fzf
if ! command -v fzf &>/dev/null; then
  return
fi

# load default keybindings
if [[ -e ~/.config/fzf/key-bindings.bash ]]; then
  # shellcheck source=/dev/null
  source ~/.config/fzf/key-bindings.bash
elif [[ -e /usr/share/doc/fzf/examples/key-bindings.bash ]]; then
  # shellcheck source=/dev/null
  source /usr/share/doc/fzf/examples/key-bindings.bash
fi

# https://github.com/junegunn/fzf#environment-variables
# use fd in place of find if available
if [[ -z "${FZF_DEFAULT_COMMAND+x}" ]] && command -v fd &>/dev/null; then
  export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'
fi

# load completion to get shell integration without first calling fzf<TAB>
if command -v __load_completion &>/dev/null && ! command -v _fzf_setup_completion &>/dev/null; then
  __load_completion fzf
fi
