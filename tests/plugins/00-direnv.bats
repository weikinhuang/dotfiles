#!/usr/bin/env bats

setup() {
  load '../helpers/common'
  setup_plugin_test_env
}

@test "00-direnv: returns early when direnv is unavailable" {
  use_mock_bin_path

  source "${REPO_ROOT}/plugins/00-direnv.sh"

  [ -z "${DIRENV_LOG_FORMAT+x}" ]
  [ "${#DOT_TEST_CACHED_EVALS[@]}" -eq 0 ]
}

@test "00-direnv: exports quiet logging and evaluates the direnv hook" {
  stub_command direnv <<'EOF'
#!/usr/bin/env bash
printf 'export DIRENV_HOOK_LOADED=1\n'
EOF

  source "${REPO_ROOT}/plugins/00-direnv.sh"

  [ -n "${DIRENV_LOG_FORMAT+x}" ]
  [ "${DIRENV_LOG_FORMAT}" = "" ]
  [ "${DIRENV_HOOK_LOADED}" = "1" ]
  [ "${DOT_TEST_CACHED_EVALS[0]}" = "direnv|direnv hook bash" ]
}
