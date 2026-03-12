#!/usr/bin/env bats

setup() {
  load '../../helpers/common'
  source "${REPO_ROOT}/dotenv/linux/prompt.sh"
}

@test "linux/prompt: defines __ps1_proc_use from the current system load average" {
  run __ps1_proc_use
  assert_success

  if [[ -r /proc/loadavg ]]; then
    local expected
    read -r expected _ </proc/loadavg
    assert_output "${expected}"
  else
    [[ "${output}" =~ ^[0-9]+([.][0-9]+)?$ ]]
  fi
}

@test "linux/prompt: ps1-proc-use falls back to uptime parsing when /proc/loadavg is unavailable" {
  local mock_bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${mock_bin}"
  cat >"${mock_bin}/uptime" <<'EOF'
#!/usr/bin/env bash
echo ' 12:00:00 up 1 day,  3 users,  load average: 0.91, 0.52, 0.33'
EOF
  chmod +x "${mock_bin}/uptime"

  run bash -c 'PATH="$2:/usr/bin:/bin"; source <(sed "s#\\[\\[ -r /proc/loadavg \\]\\]#false#" "$1"); __ps1_proc_use' \
    _ "${REPO_ROOT}/dotenv/linux/prompt.sh" "${mock_bin}"
  assert_success
  assert_output "0.91"
}
