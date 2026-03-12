#!/usr/bin/env bats

setup() {
  load '../../helpers/common'
  setup_test_bin

  cat >"${MOCK_BIN}/ifconfig" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST>
  inet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST>
  inet 10.0.0.5 netmask 0xffffff00 broadcast 10.0.0.255
  inet6 fe80::1%lo0 prefixlen 64 scopeid 0x1
OUT
EOF
  chmod +x "${MOCK_BIN}/ifconfig"

  source "${REPO_ROOT}/dotenv/darwin/aliases.sh"
}

@test "darwin/aliases: ips prints IPv4 addresses from ifconfig" {
  run ips
  assert_success
  assert_line --index 0 "127.0.0.1"
  assert_line --index 1 "10.0.0.5"
}
