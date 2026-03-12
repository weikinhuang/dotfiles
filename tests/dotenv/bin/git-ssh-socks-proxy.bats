#!/usr/bin/env bats

setup() {
  load '../../helpers/common'
  setup_test_bin
  setup_isolated_home
  SCRIPT="${REPO_ROOT}/dotenv/bin/git-ssh-socks-proxy"

  stub_command ssh <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
}

@test "git-ssh-socks-proxy: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Run ssh with an automatically configured ProxyCommand"
    assert_output --partial "-p, --port PORT"
    assert_output --partial "-h, -?, --help"
  done
}

@test "git-ssh-socks-proxy: falls back to plain ssh when netcat is unavailable" {
  run bash "${SCRIPT}" git@example.com
  assert_success
  assert_output "git@example.com"
}

@test "git-ssh-socks-proxy: injects a host and port specific proxy command" {
  stub_command nc <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  git config --global 'ssh-socks.example.com:2222.proxy' 'corp-proxy:1080'
  git config --global 'ssh-socks.example.com:2222.version' '4'
  git config --global 'ssh-socks.example.com:2222.nc' '--proxy-opt'

  run bash "${SCRIPT}" -p 2222 git@example.com
  assert_success
  assert_line --index 0 "-o"
  assert_line --index 1 "ProxyCommand=nc --proxy-opt -X 4 -x corp-proxy:1080 %h %p"
  assert_line --index 2 "-p"
  assert_line --index 3 "2222"
  assert_line --index 4 "git@example.com"
}

@test "git-ssh-socks-proxy: optional proxies are skipped when the probe fails" {
  stub_command nc <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-w1" ]]; then
  exit 1
fi
exit 0
EOF
  git config --global 'ssh-socks.example.com.proxy' 'corp-proxy:1080'
  git config --global 'ssh-socks.example.com.optional' 'true'

  run bash "${SCRIPT}" git@example.com
  assert_success
  refute_output --partial "ProxyCommand="
  assert_output "git@example.com"
}

@test "git-ssh-socks-proxy: GIT_SSH_NO_PROXY bypasses configured proxies" {
  stub_command nc <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  git config --global 'ssh-socks.example.com.proxy' 'corp-proxy:1080'

  run env GIT_SSH_NO_PROXY=example.com bash "${SCRIPT}" git@example.com
  assert_success
  refute_output --partial "ProxyCommand="
  assert_output "git@example.com"
}
