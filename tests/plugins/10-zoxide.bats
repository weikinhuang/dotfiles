#!/usr/bin/env bats
# Tests for plugins/10-zoxide.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "10-zoxide: evaluates the zoxide init snippet" {
  stub_command zoxide <<'EOF'
#!/usr/bin/env bash
printf 'export ZOXIDE_INIT_LOADED=1\n'
EOF

  source "${REPO_ROOT}/plugins/10-zoxide.sh"

  [ "${ZOXIDE_INIT_LOADED}" = "1" ]
  [ "${DOT_TEST_CACHED_EVALS[0]}" = "zoxide|zoxide init bash" ]
}
