#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/linux/bin/pbpaste"
}

@test "pbpaste: prefers xclip and sets DISPLAY when it is missing" {
  export PATH="${MOCK_BIN}"

  stub_command xclip <<'EOF'
#!/usr/bin/env bash
printf 'DISPLAY=%s\n' "${DISPLAY:-}"
printf '%s\n' "$@"
EOF

  run /bin/bash -c "unset DISPLAY; /bin/bash '${SCRIPT}'"
  assert_success
  assert_line --index 0 "DISPLAY=:0"
  assert_line --index 1 "-selection"
  assert_line --index 2 "clipboard"
  assert_line --index 3 "-o"
}

@test "pbpaste: falls back to xsel when xclip is absent" {
  export PATH="${MOCK_BIN}"

  stub_command xsel <<'EOF'
#!/usr/bin/env bash
printf 'DISPLAY=%s\n' "${DISPLAY:-}"
printf '%s\n' "$@"
EOF

  run /bin/bash -c "unset DISPLAY; /bin/bash '${SCRIPT}'"
  assert_success
  assert_line --index 0 "DISPLAY=:0"
  assert_line --index 1 "-o"
  assert_line --index 2 "--clipboard"
}

@test "pbpaste: exits with an error when no clipboard backend is installed" {
  export PATH="${MOCK_BIN}"

  run bash "${SCRIPT}"
  assert_failure
  assert_output "pbpaste: requires xclip or xsel"
}
