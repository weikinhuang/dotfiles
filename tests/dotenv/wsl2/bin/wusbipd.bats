#!/usr/bin/env bats
# Tests for dotenv/wsl2/bin/wusbipd.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl2/bin/wusbipd"

  setup_mock_windows_root
  mkdir -p "${MOCK_WIN_ROOT}/mnt/c/Program Files/usbipd-win"
  stub_mock_wslpath
  stub_passthrough_command "winsudo"

  write_executable "${MOCK_WIN_ROOT}/mnt/c/Program Files/usbipd-win/usbipd.exe" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
}

@test "wusbipd: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: wusbipd [OPTION]... [USBIPD-ARG...]"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "wusbipd: invokes winsudo with the default Program Files executable" {
  run bash "${SCRIPT}" list --json
  assert_success
  assert_line --index 0 "${MOCK_WIN_ROOT}/mnt/c/Program Files/usbipd-win/usbipd.exe"
  assert_line --index 1 "list"
  assert_line --index 2 "--json"
}

@test "wusbipd: prefers Program Files (x86) when that install path exists" {
  mkdir -p "${MOCK_WIN_ROOT}/mnt/c/Program Files (x86)/usbipd-win"
  write_executable "${MOCK_WIN_ROOT}/mnt/c/Program Files (x86)/usbipd-win/usbipd.exe" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  run bash "${SCRIPT}" attach
  assert_success
  assert_line --index 0 "${MOCK_WIN_ROOT}/mnt/c/Program Files (x86)/usbipd-win/usbipd.exe"
  assert_line --index 1 "attach"
}

@test "wusbipd: fails when the Program Files (x86) directory exists but usbipd.exe does not" {
  mkdir -p "${MOCK_WIN_ROOT}/mnt/c/Program Files (x86)/usbipd-win"

  run bash "${SCRIPT}" list
  assert_failure
}

@test "wusbipd: fails when usbipd.exe is unavailable" {
  rm -f "${MOCK_WIN_ROOT}/mnt/c/Program Files/usbipd-win/usbipd.exe"

  run bash "${SCRIPT}" list
  assert_failure
}

@test "wusbipd: propagates winsudo failures" {
  stub_command "winsudo" <<'EOF'
#!/usr/bin/env bash
exit 9
EOF

  run bash "${SCRIPT}" list
  assert_failure
  [[ "${status}" -eq 9 ]]
}
