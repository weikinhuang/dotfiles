# shellcheck shell=bash
# Configure fzf completions and key bindings.
# SPDX-License-Identifier: MIT

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
__dot_fzf_fd_bin="${DOTFILES__FD_COMMAND:-}"
if [[ -z "${__dot_fzf_fd_bin}" ]]; then
  if command -v fd &>/dev/null; then
    __dot_fzf_fd_bin="fd"
  elif command -v fdfind &>/dev/null; then
    __dot_fzf_fd_bin="fdfind"
  fi
fi

if [[ -z "${FZF_DEFAULT_COMMAND+x}" ]] && [[ -n "${__dot_fzf_fd_bin}" ]]; then
  export FZF_DEFAULT_COMMAND="${__dot_fzf_fd_bin} --type f --hidden --follow --exclude .git"
  export FZF_CTRL_T_COMMAND="${FZF_DEFAULT_COMMAND}"
  export FZF_ALT_C_COMMAND="${__dot_fzf_fd_bin} --type d --hidden --follow --exclude .git"
fi
unset __dot_fzf_fd_bin

# sensible default options
if [[ -z "${FZF_DEFAULT_OPTS+x}" ]]; then
  export FZF_DEFAULT_OPTS="
    --height=40%
    --layout=reverse
    --border
    --info=inline-right
    --cycle
    --highlight-line
    --marker='*'
    --bind='ctrl-d:half-page-down,ctrl-u:half-page-up'
  "
fi

# CTRL-T: file/dir picker with bat preview and walker-skip fallback
# --walker-skip applies when fd is not installed and fzf uses its built-in walker
# --scheme=path gives bonus points to characters after path separators
__dot_fzf_ctrl_t_opts="--scheme=path --walker-skip .git,node_modules,target"
if command -v bat &>/dev/null; then
  __dot_fzf_ctrl_t_opts="${__dot_fzf_ctrl_t_opts} --preview 'bat -n --color=always --line-range :300 {} 2>/dev/null || cat {}'"
  __dot_fzf_ctrl_t_opts="${__dot_fzf_ctrl_t_opts} --bind 'ctrl-/:change-preview-window(down|hidden|)'"
fi
export FZF_CTRL_T_OPTS="${__dot_fzf_ctrl_t_opts}"
unset __dot_fzf_ctrl_t_opts

# ALT-C: directory picker with tree preview
__dot_fzf_alt_c_opts="--walker-skip .git,node_modules,target"
if command -v tree &>/dev/null; then
  __dot_fzf_alt_c_opts="${__dot_fzf_alt_c_opts} --preview 'tree -C -L 2 {} | head -80'"
fi
export FZF_ALT_C_OPTS="${__dot_fzf_alt_c_opts}"
unset __dot_fzf_alt_c_opts

# CTRL-R: history search with chronological scoring
export FZF_CTRL_R_OPTS="--scheme=history --bind='ctrl-y:execute-silent(echo -n {2..} | clipboard-copy)+abort' --header='Press CTRL-Y to copy command to clipboard'"

# load completion to get shell integration without first calling fzf<TAB>
if command -v __load_completion &>/dev/null && ! command -v _fzf_setup_completion &>/dev/null; then
  __load_completion fzf
fi
