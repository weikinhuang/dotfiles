#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/ssh/bin/pbpaste"
}

teardown() {
  if [[ -n "${SOCKET_PID:-}" ]]; then
    kill "${SOCKET_PID}" 2>/dev/null || true
    wait "${SOCKET_PID}" 2>/dev/null || true
  fi
}

@test "pbpaste: reads from the clipboard server when a listening port is configured" {
  stub_clipboard_server_curl

  run env CLIPBOARD_SERVER_PORT=4567 bash "${SCRIPT}"
  assert_success
  assert_line --index 0 "-sSL"
  assert_line --index 1 "-X"
  assert_line --index 2 "GET"
  assert_line --index 3 "http://localhost:4567/clipboard"
}

@test "pbpaste: reads through the configured Unix socket when it exists" {
  local socket_path="${BATS_TEST_TMPDIR}/clipboard-server.sock"
  SOCKET_PID="$(start_unix_socket_listener "${socket_path}")"
  stub_clipboard_server_curl

  run env CLIPBOARD_SERVER_SOCK="${socket_path}" bash "${SCRIPT}"
  assert_success
  assert_line --index 0 "-sSL"
  assert_line --index 1 "--unix-socket"
  assert_line --index 2 "${socket_path}"
  assert_line --index 3 "-X"
  assert_line --index 4 "GET"
  assert_line --index 5 "http://localhost/clipboard"
}

@test "pbpaste: falls back to the local pbpaste when the server ping fails" {
  export PATH="${REPO_ROOT}/dotenv/ssh/bin:${MOCK_BIN}:/usr/bin:/bin"
  stub_clipboard_server_curl --fail-ping

  stub_command pbpaste <<'EOF'
#!/usr/bin/env bash
printf 'PATH=%s\n' "${PATH}"
printf 'LOCAL_PBPASTE\n'
EOF

  run env CLIPBOARD_SERVER_PORT=4567 bash "${SCRIPT}"
  assert_success
  assert_line --index 1 "LOCAL_PBPASTE"
  refute_output --partial "dotenv/ssh/bin"
}

@test "pbpaste: falls back to the local pbpaste after removing dotenv/ssh/bin from PATH" {
  export PATH="${REPO_ROOT}/dotenv/ssh/bin:${MOCK_BIN}:/usr/bin:/bin"

  stub_command pbpaste <<'EOF'
#!/usr/bin/env bash
printf 'PATH=%s\n' "${PATH}"
printf 'LOCAL_PBPASTE\n'
EOF

  run bash "${SCRIPT}"
  assert_success
  assert_line --index 1 "LOCAL_PBPASTE"
  refute_output --partial "dotenv/ssh/bin"
}
