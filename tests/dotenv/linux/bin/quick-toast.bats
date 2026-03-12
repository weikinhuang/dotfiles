#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/linux/bin/quick-toast"
}

@test "quick-toast: rings the terminal bell and exits 1 when notify-send is unavailable" {
  export PATH="${MOCK_BIN}"

  run bash "${SCRIPT}"
  assert_failure
  assert_output $'\a'
}

@test "quick-toast: supplies a default message and DISPLAY when notify-send is available" {
  stub_command notify-send <<'EOF'
#!/usr/bin/env bash
printf 'DISPLAY=%s\n' "${DISPLAY:-}"
printf '%s\n' "$@"
EOF

  run env -u DISPLAY bash "${SCRIPT}"
  assert_success
  assert_line --index 0 "DISPLAY=:0"
  assert_line --index 1 "ALERT FROM TERMINAL"
}

@test "quick-toast: preserves DISPLAY and forwards all notification arguments" {
  stub_command notify-send <<'EOF'
#!/usr/bin/env bash
printf 'DISPLAY=%s\n' "${DISPLAY:-}"
printf '%s\n' "$@"
EOF

  run env DISPLAY=:99 bash "${SCRIPT}" "Build done" "All checks passed"
  assert_success
  assert_line --index 0 "DISPLAY=:99"
  assert_line --index 1 "Build done"
  assert_line --index 2 "All checks passed"
}
