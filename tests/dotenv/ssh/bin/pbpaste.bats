#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/ssh/bin/pbpaste"
}

@test "pbpaste: reads from the clipboard server when a listening port is configured" {
  stub_command curl <<'EOF'
#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == */ping ]]; then
    exit 0
  fi
done
printf '%s\n' "$@"
EOF

  run env CLIPBOARD_SERVER_PORT=4567 bash "${SCRIPT}"
  assert_success
  assert_line --index 0 "-sSL"
  assert_line --index 1 "-X"
  assert_line --index 2 "GET"
  assert_line --index 3 "http://localhost:4567/clipboard"
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
