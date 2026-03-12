#!/usr/bin/env bats
# Tests for plugins/10-lesspipe.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "10-lesspipe: caches and sources lesspipe output" {
  stub_command lesspipe.sh <<'EOF'
#!/usr/bin/env bash
printf 'export LESSOPEN=%q\n' '|lesspipe %s'
EOF

  source "${REPO_ROOT}/plugins/10-lesspipe.sh"

  [ "${LESSOPEN}" = "|lesspipe %s" ]
  [ -f "${DOTFILES__CONFIG_DIR}/cache/lesspipe.bash" ]
  grep -F "LESSOPEN" "${DOTFILES__CONFIG_DIR}/cache/lesspipe.bash"
}
