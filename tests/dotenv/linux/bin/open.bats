#!/usr/bin/env bats

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/linux/bin/open"
}

@test "open: prefers xdg-open when it is available" {
  export PATH="${MOCK_BIN}"

  stub_command xdg-open <<'EOF'
#!/usr/bin/env bash
printf 'xdg-open\n'
printf '%s\n' "$@"
EOF

  stub_command gnome-open <<'EOF'
#!/usr/bin/env bash
printf 'gnome-open\n'
printf '%s\n' "$@"
EOF

  run bash "${SCRIPT}" target.txt
  assert_success
  assert_line --index 0 "xdg-open"
  assert_line --index 1 "target.txt"
}

@test "open: falls back to gnome-open when xdg-open is absent" {
  export PATH="${MOCK_BIN}"

  stub_command gnome-open <<'EOF'
#!/usr/bin/env bash
printf 'gnome-open\n'
printf '%s\n' "$@"
EOF

  run bash "${SCRIPT}" target.txt
  assert_success
  assert_line --index 0 "gnome-open"
  assert_line --index 1 "target.txt"
}

@test "open: falls back to nautilus when no other opener exists" {
  export PATH="${MOCK_BIN}"

  stub_command nautilus <<'EOF'
#!/usr/bin/env bash
printf 'nautilus\n'
printf '%s\n' "$@"
EOF

  run bash "${SCRIPT}" target.txt
  assert_success
  assert_line --index 0 "nautilus"
  assert_line --index 1 "target.txt"
}
