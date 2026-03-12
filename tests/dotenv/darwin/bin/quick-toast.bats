#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/darwin/bin/quick-toast"

  stub_command osascript <<'EOF'
#!/usr/bin/env bash
printf 'ARG:%s\n' "$@"
cat
EOF
}

@test "quick-toast: uses the default notification title and body when called without arguments" {
  run bash "${SCRIPT}"
  assert_success
  assert_line --index 0 "ARG:-"
  assert_line --index 1 "ARG:Terminal Notification"
  assert_line --index 2 "ARG:ALERT FROM TERMINAL"
  assert_output --partial "display notification (item 2 of argv) with title (item 1 of argv)"
}

@test "quick-toast: forwards a custom title and body to osascript" {
  run bash "${SCRIPT}" "Build done" "All checks passed"
  assert_success
  assert_line --index 0 "ARG:-"
  assert_line --index 1 "ARG:Build done"
  assert_line --index 2 "ARG:All checks passed"
}
