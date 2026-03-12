#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/ssh/bin/pbcopy"
}

@test "pbcopy: posts stdin to the clipboard server when a listening port is configured" {
  stub_command curl <<'EOF'
#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == */ping ]]; then
    exit 0
  fi
done
printf '%s\n' "$@"
cat
EOF

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

@test "pbcopy: falls back to the local pbcopy after removing dotenv/ssh/bin from PATH" {
  export PATH="${REPO_ROOT}/dotenv/ssh/bin:${MOCK_BIN}:/usr/bin:/bin"

  stub_command pbcopy <<'EOF'
#!/usr/bin/env bash
printf 'PATH=%s\n' "${PATH}"
printf '%s\n' "$@"
cat
EOF

  run bash -c "printf 'copied text' | bash '${SCRIPT}' extra"
  assert_success
  assert_line --index 1 "extra"
  assert_line --index 2 "copied text"
  refute_output --partial "dotenv/ssh/bin"
}
