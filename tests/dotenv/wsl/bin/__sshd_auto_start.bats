#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/__sshd_auto_start.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/__sshd_auto_start.sh"

  stub_command sudo <<'EOF'
#!/usr/bin/env bash
printf 'SUDO %s\n' "$*"
EOF
}

@test "__sshd_auto_start: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: __sshd_auto_start.sh"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "__sshd_auto_start: provisions sshd when no pid file is present" {
  [[ ! -e /var/run/sshd.pid ]] || skip "/var/run/sshd.pid exists on this host"

  run bash "${SCRIPT}"
  assert_success
  assert_line --index 0 "SUDO rm -f /var/run/sshd.pid"
  assert_line --index 1 "SUDO mkdir -p /run/sshd"
  assert_line --index 2 "SUDO /usr/sbin/sshd -D"
}
