#!/usr/bin/env bats

setup() {
  load '../../helpers/common'
  setup_test_bin

  cat >"${MOCK_BIN}/ip" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
1: lo: <LOOPBACK>
    inet 127.0.0.1/8 scope host lo
2: eth0: <BROADCAST>
    inet 192.168.10.20/24 brd 192.168.10.255 scope global eth0
    inet6 ::1/128 scope host
OUT
EOF
  chmod +x "${MOCK_BIN}/ip"

  source "${REPO_ROOT}/dotenv/linux/aliases.sh"
}

@test "linux/aliases: ips prints IPv4 addresses from ip addr" {
  run ips
  assert_success
  assert_line --index 0 "127.0.0.1"
  assert_line --index 1 "192.168.10.20"
}
