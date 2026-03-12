#!/usr/bin/env bats
# Tests for plugins/10-dircolors.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "10-dircolors: returns early when dircolors is unavailable" {
  use_mock_bin_path

  source "${REPO_ROOT}/plugins/10-dircolors.sh"

  [ -z "${LS_COLORS+x}" ]
}

@test "10-dircolors: loads the configured solarized theme" {
  export DOT_SOLARIZED_LIGHT=1
  stub_command dircolors <<'EOF'
#!/usr/bin/env bash
printf 'DOT_DIRCOLORS_PATH=%s\n' "$1"
printf 'export LS_COLORS=theme-light\n'
EOF

  source "${REPO_ROOT}/plugins/10-dircolors.sh"

  [ "${DOT_DIRCOLORS_PATH}" = "${DOTFILES__ROOT}/.dotfiles/external/dircolors.solarized.256light" ]
  [ "${LS_COLORS}" = "theme-light" ]
}
