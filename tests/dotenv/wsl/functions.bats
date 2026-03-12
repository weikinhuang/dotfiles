#!/usr/bin/env bats

setup() {
  load '../../helpers/common'
  setup_test_bin
}

@test "wsl/functions: cmd0 strips carriage returns from cmd.exe output" {
  stub_command "cmd.exe" <<'EOF'
#!/usr/bin/env bash
printf 'hello\r\n'
EOF

  source "${REPO_ROOT}/dotenv/wsl/functions.sh"

  run cmd0 echo hello
  assert_success
  assert_output "hello"
}

@test "wsl/functions: cmd0 returns the cmd.exe exit status" {
  stub_command "cmd.exe" <<'EOF'
#!/usr/bin/env bash
printf 'failed\r\n'
exit 7
EOF

  source "${REPO_ROOT}/dotenv/wsl/functions.sh"

  run cmd0 nope
  assert_failure
  [[ "${status}" -eq 7 ]]
  assert_output "failed"
}
