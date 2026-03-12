#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/ssh/bin/pbcopy"
}

teardown() {
  if [[ -n "${SOCKET_PID:-}" ]]; then
    kill "${SOCKET_PID}" 2>/dev/null || true
    wait "${SOCKET_PID}" 2>/dev/null || true
  fi
}

@test "pbcopy: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: pbcopy"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "pbcopy: posts stdin to the clipboard server when a listening port is configured" {
  stub_clipboard_server_curl --stdin

  run bash -c "printf 'copied text' | CLIPBOARD_SERVER_PORT=4567 bash '${SCRIPT}'"
  assert_success
  assert_line --index 0 "-sSL"
  assert_line --index 1 "-X"
  assert_line --index 2 "POST"
  assert_line --index 3 "http://localhost:4567/clipboard"
  assert_line --index 4 "--data-binary"
  assert_line --index 5 "@-"
  assert_line --index 6 "copied text"
}

@test "pbcopy: posts stdin through the configured Unix socket when it exists" {
  local socket_path="${BATS_TEST_TMPDIR}/clipboard-server.sock"
  SOCKET_PID="$(start_unix_socket_listener "${socket_path}")"
  stub_clipboard_server_curl --stdin

  run bash -c "printf 'copied text' | CLIPBOARD_SERVER_SOCK='${socket_path}' bash '${SCRIPT}'"
  assert_success
  assert_line --index 0 "-sSL"
  assert_line --index 1 "--unix-socket"
  assert_line --index 2 "${socket_path}"
  assert_line --index 3 "-X"
  assert_line --index 4 "POST"
  assert_line --index 5 "http://localhost/clipboard"
  assert_line --index 6 "--data-binary"
  assert_line --index 7 "@-"
  assert_line --index 8 "copied text"
}

@test "pbcopy: falls back to the local pbcopy when the server ping fails" {
  export PATH="${REPO_ROOT}/dotenv/ssh/bin:${MOCK_BIN}:/usr/bin:/bin"
  stub_clipboard_server_curl --fail-ping
  stub_env_passthrough_command_with_stdin "pbcopy" "PATH"

  run bash -c "printf 'copied text' | CLIPBOARD_SERVER_PORT=4567 bash '${SCRIPT}' extra"
  assert_success
  assert_line --index 1 "extra"
  assert_line --index 2 "copied text"
  refute_output --partial "dotenv/ssh/bin"
}

@test "pbcopy: falls back to the local pbcopy after removing dotenv/ssh/bin from PATH" {
  export PATH="${REPO_ROOT}/dotenv/ssh/bin:${MOCK_BIN}:/usr/bin:/bin"

  stub_env_passthrough_command_with_stdin "pbcopy" "PATH"

  run bash -c "printf 'copied text' | bash '${SCRIPT}' extra"
  assert_success
  assert_line --index 1 "extra"
  assert_line --index 2 "copied text"
  refute_output --partial "dotenv/ssh/bin"
}
