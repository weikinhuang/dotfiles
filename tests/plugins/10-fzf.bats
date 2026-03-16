#!/usr/bin/env bats
# Tests for plugins/10-fzf.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "10-fzf: loads keybindings, defaults, previews, and completion hooks" {
  mkdir -p "${HOME}/.config/fzf"
  cat >"${HOME}/.config/fzf/key-bindings.bash" <<'EOF'
FZF_KEYBINDINGS_LOADED=1
EOF

  stub_fixed_output_command fzf ""
  stub_fixed_output_command fd ""
  stub_fixed_output_command bat ""
  stub_fixed_output_command tree ""

  __load_completion() {
    FZF_COMPLETION_LOADED="$1"
  }

  source "${REPO_ROOT}/plugins/10-fzf.sh"

  [ "${FZF_KEYBINDINGS_LOADED}" = "1" ]
  [ "${FZF_DEFAULT_COMMAND}" = "fd --type f --hidden --follow --exclude .git" ]
  [ "${FZF_CTRL_T_COMMAND}" = "${FZF_DEFAULT_COMMAND}" ]
  [ "${FZF_ALT_C_COMMAND}" = "fd --type d --hidden --follow --exclude .git" ]
  [[ "${FZF_DEFAULT_OPTS}" == *"--height=40%"* ]]
  [[ "${FZF_DEFAULT_OPTS}" == *"--highlight-line"* ]]
  [[ "${FZF_CTRL_T_OPTS}" == *"bat -n --color=always"* ]]
  [[ "${FZF_ALT_C_OPTS}" == *"tree -C -L 2"* ]]
  [[ "${FZF_CTRL_R_OPTS}" == *"clipboard-copy"* ]]
  [ "${FZF_COMPLETION_LOADED}" = "fzf" ]
}

@test "10-fzf: honors DOTFILES__FD_COMMAND when fd uses a distro-specific binary name" {
  stub_fixed_output_command fzf ""
  export DOTFILES__FD_COMMAND="fdfind"

  source "${REPO_ROOT}/plugins/10-fzf.sh"

  [ "${FZF_DEFAULT_COMMAND}" = "fdfind --type f --hidden --follow --exclude .git" ]
  [ "${FZF_ALT_C_COMMAND}" = "fdfind --type d --hidden --follow --exclude .git" ]
}
