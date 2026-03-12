#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/npp

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/npp"

  setup_mock_windows_root
  mkdir -p "${MOCK_WIN_ROOT}/mnt/c/Program Files/Notepad++"
  stub_mock_wslpath

  write_executable "${MOCK_WIN_ROOT}/mnt/c/Program Files/Notepad++/notepad++.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
}

@test "npp: translates file paths and appends piped stdin" {
  local test_file="${BATS_TEST_TMPDIR}/sample.txt"
  echo "content" >"${test_file}"

  run bash -c "printf 'stdin payload' | bash '${SCRIPT}' '${test_file}' --flag"
  assert_success
  assert_line --index 0 "-multiInst"
  assert_line --index 1 "-nosession"
  assert_line --index 2 --regexp '^C:\\'
  assert_line --index 3 "--flag"
  assert_line --index 4 "stdin payload"
}

@test "npp: falls back to a vi-style editor when Notepad++ is unavailable" {
  rm -f "${MOCK_WIN_ROOT}/mnt/c/Program Files/Notepad++/notepad++.exe"

  stub_command which <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${MOCK_BIN}/fake-vi"
EOF

  stub_command fake-vi <<'EOF'
#!/usr/bin/env bash
printf 'FALLBACK %s\n' "$@"
EOF

  run bash "${SCRIPT}" one two
  assert_success
  assert_line --index 0 "FALLBACK one"
  assert_line --index 1 "FALLBACK two"
}

@test "npp: prefers the Program Files (x86) installation when it exists" {
  mkdir -p "${MOCK_WIN_ROOT}/mnt/c/Program Files (x86)/Notepad++"
  write_executable "${MOCK_WIN_ROOT}/mnt/c/Program Files (x86)/Notepad++/notepad++.exe" <<'EOF'
#!/usr/bin/env bash
printf 'X86 %s\n' "$@"
EOF

  run bash "${SCRIPT}" sample.txt
  assert_success
  assert_line --index 0 "X86 -multiInst"
  assert_line --index 1 "X86 -nosession"
}
