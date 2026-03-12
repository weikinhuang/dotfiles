#!/usr/bin/env bats

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  use_mock_bin_path
  stub_command docker <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "compose" ]] && [[ "${2:-}" == "version" ]]; then
  exit 0
fi
printf '%s\n' "$@"
EOF
}

@test "90-docker: sets docker defaults and adds the compose v2 compatibility function" {
  source "${REPO_ROOT}/plugins/90-docker.sh"

  [[ "${HISTIGNORE}" == *"docker-compose up"* ]]
  [ "${COMPOSE_HTTP_TIMEOUT}" = "7200" ]
  [ "$(type -t docker-compose)" = "function" ]

  run docker-compose up
  assert_success
  assert_output $'compose\nup'
}
