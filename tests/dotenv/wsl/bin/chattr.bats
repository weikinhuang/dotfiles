#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/chattr

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/chattr"

  setup_mock_windows_root
  mkdir -p "${MOCK_WIN_ROOT}/mnt/c/Windows/system32"
  stub_mock_wslpath

  write_executable "${MOCK_WIN_ROOT}/mnt/c/Windows/system32/attrib.exe" <<'EOF'
#!/usr/bin/env bash
printf 'ATTRIB %s\n' "$@"
EOF

  TEST_FILE="${BATS_TEST_TMPDIR}/sample.txt"
  echo "content" >"${TEST_FILE}"
}

@test "chattr: help delegates to attrib with /?" {
  run bash "${SCRIPT}" --help
  assert_success
  assert_output "ATTRIB /?"
}

@test "chattr: existing files are translated and duplicate flags are deduplicated" {
  run bash "${SCRIPT}" +r +R /s --all "${TEST_FILE}"
  assert_success
  assert_line --index 0 "ATTRIB +R"
  assert_line --index 1 --regexp '^ATTRIB C:\\'
  assert_line --index 2 "ATTRIB /S"
  assert_line --index 3 "ATTRIB /D"
  [[ "$(grep -c '^ATTRIB +R$' <<<"${output}")" -eq 1 ]]
  [[ "$(grep -c '^ATTRIB /S$' <<<"${output}")" -eq 1 ]]
}

@test "chattr: missing files fail before invoking attrib" {
  run bash "${SCRIPT}" "${BATS_TEST_TMPDIR}/missing.txt"
  assert_failure
  assert_output "Path ${BATS_TEST_TMPDIR}/missing.txt not found."
}

@test "chattr: with no file runs bare attrib" {
  run bash "${SCRIPT}"
  assert_success
  assert_output "ATTRIB "
}
