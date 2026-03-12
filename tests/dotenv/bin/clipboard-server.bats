#!/usr/bin/env bats
# Tests for dotenv/bin/clipboard-server.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/bin/clipboard-server"
  NODE_BIN="$(command -v node || command -v nodejs)"
  SOCKET="${BATS_TEST_TMPDIR}/clipboard-server.sock"
  CLIPBOARD_WRITE_FILE="${BATS_TEST_TMPDIR}/clipboard-write.txt"
  NOTIFY_LOG="${BATS_TEST_TMPDIR}/quick-toast.log"
  export CLIPBOARD_WRITE_FILE NOTIFY_LOG

  stub_command pbcopy <<'EOF'
#!/usr/bin/env bash
cat >"${CLIPBOARD_WRITE_FILE}"
EOF

  stub_command pbpaste <<'EOF'
#!/usr/bin/env bash
printf '%s' "${MOCK_PBPASTE_CONTENT:-mock clipboard contents}"
EOF

  stub_command quick-toast <<'EOF'
#!/usr/bin/env bash
printf '%s|%s\n' "$1" "$2" >>"${NOTIFY_LOG}"
EOF
}

teardown() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill -HUP "${SERVER_PID}" 2>/dev/null || kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}

start_server() {
  "${NODE_BIN}" "${SCRIPT}" server --socket "${SOCKET}" "$@" >"${BATS_TEST_TMPDIR}/server.log" 2>&1 &
  SERVER_PID=$!

  for _ in {1..50}; do
    if curl -sS --unix-socket "${SOCKET}" http://localhost/ping >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done

  cat "${BATS_TEST_TMPDIR}/server.log" >&2
  return 1
}

wait_for_notification() {
  local message="$1"
  for _ in {1..20}; do
    if [[ -f "${NOTIFY_LOG}" ]] && grep -q "${message}" "${NOTIFY_LOG}"; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}

@test "clipboard-server: -h and --help print usage" {
  for flag in -h --help; do
    run "${NODE_BIN}" "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: clipboard-server COMMAND"
    assert_output --partial "Options:"
    assert_output --partial "-e, --enable-paste"
    assert_output --partial "-h, --help"
  done
}

@test "clipboard-server: GET /clipboard is forbidden unless paste is enabled" {
  start_server

  run curl -sS -o /dev/null -w '%{http_code}' --unix-socket "${SOCKET}" http://localhost/clipboard
  assert_success
  assert_output "403"
}

@test "clipboard-server: POST /clipboard writes to pbcopy and emits a notification" {
  start_server --notify

  run curl -sS --unix-socket "${SOCKET}" http://localhost/clipboard --data-binary "hello from bats"
  assert_success
  [[ "$(cat "${CLIPBOARD_WRITE_FILE}")" == "hello from bats" ]]
  wait_for_notification "Clipboard written"
}

@test "clipboard-server: GET /clipboard returns pbpaste output when paste is enabled" {
  export MOCK_PBPASTE_CONTENT="clipboard from stub"
  start_server --enable-paste --notify

  run curl -sS --unix-socket "${SOCKET}" http://localhost/clipboard
  assert_success
  assert_output "clipboard from stub"
  wait_for_notification "Clipboard read"
}
