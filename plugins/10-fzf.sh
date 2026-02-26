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
  export FZF_CTRL_T_COMMAND="${FZF_DEFAULT_COMMAND}"
  export FZF_ALT_C_COMMAND='fd --type d --hidden --follow --exclude .git'
fi

# sensible default options
if [[ -z "${FZF_DEFAULT_OPTS+x}" ]]; then
  export FZF_DEFAULT_OPTS="
    --height=40%
    --layout=reverse
    --border
    --info=inline
    --cycle
    --marker='*'
    --bind='ctrl-d:half-page-down,ctrl-u:half-page-up'
  "
fi

# CTRL-T: file/dir picker with bat preview and walker-skip fallback
# --walker-skip applies when fd is not installed and fzf uses its built-in walker
_fzf_ct_opts="--walker-skip .git,node_modules,target"
if command -v bat &>/dev/null; then
  _fzf_ct_opts="${_fzf_ct_opts} --preview 'bat -n --color=always --line-range :300 {} 2>/dev/null || cat {}'"
  _fzf_ct_opts="${_fzf_ct_opts} --bind 'ctrl-/:change-preview-window(down|hidden|)'"
fi
export FZF_CTRL_T_OPTS="${_fzf_ct_opts}"
unset _fzf_ct_opts

# ALT-C: directory picker with tree preview
_fzf_ac_opts="--walker-skip .git,node_modules,target"
if command -v tree &>/dev/null; then
  _fzf_ac_opts="${_fzf_ac_opts} --preview 'tree -C -L 2 {} | head -80'"
fi
export FZF_ALT_C_OPTS="${_fzf_ac_opts}"
unset _fzf_ac_opts

# load completion to get shell integration without first calling fzf<TAB>
if command -v __load_completion &>/dev/null && ! command -v _fzf_setup_completion &>/dev/null; then
  __load_completion fzf
fi
