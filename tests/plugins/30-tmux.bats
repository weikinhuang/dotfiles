#!/usr/bin/env bats
# Tests for plugins/30-tmux.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  export TERM=tmux-256color
  export TMUX=/tmp/tmux.sock
  stub_command tmux <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "show-env" ]] && [[ "${2:-}" == "-s" ]]; then
  printf 'export TMUX_PLUGIN_ENV=1\n'
fi
EOF
}

@test "30-tmux: refreshes the environment from tmux inside tmux sessions" {
  source "${REPO_ROOT}/plugins/30-tmux.sh"

  # shellcheck disable=SC2154
  [ "${__dot_prompt_actions[0]}" = "internal::tmux-reload-env" ]
  internal::tmux-reload-env
  [ "${TMUX_PLUGIN_ENV}" = "1" ]
}
