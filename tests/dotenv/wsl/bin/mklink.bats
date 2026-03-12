#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/mklink

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/mklink"

  setup_mock_windows_root
  mkdir -p "${MOCK_WIN_ROOT}/mnt/c/Windows/System32"
  stub_mock_wslpath

  write_executable "${MOCK_WIN_ROOT}/mnt/c/Windows/System32/cmd.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
}

@test "mklink: help prints usage text" {
  run bash "${SCRIPT}" --help
  assert_success
  assert_output --partial "Creates a symbolic link."
  assert_output --partial "mklink [OPTION]... TARGET LINK_NAME"
}

@test "mklink: directory targets add /d and translate absolute link paths" {
  local target_dir="${BATS_TEST_TMPDIR}/target-dir"
  local link_path="${BATS_TEST_TMPDIR}/link-dir"
  mkdir -p "${target_dir}"

  run bash "${SCRIPT}" "${target_dir}" "${link_path}"
  assert_success
  assert_line --index 0 "/c"
  assert_line --index 1 "mklink"
  assert_line --index 2 "/d"
  assert_line --index 3 --regexp '^C:\\'
  assert_line --index 4 --regexp '^C:\\'
}

@test "mklink: hard links preserve relative link names with backslashes" {
  local target_file="${BATS_TEST_TMPDIR}/target.txt"
  echo "data" >"${target_file}"

  run bash "${SCRIPT}" --hard "${target_file}" "nested/link.txt"
  assert_success
  assert_line --index 2 "/h"
  assert_line --index 3 'nested\link.txt'
}

@test "mklink: infers the link name from the target basename when only a target path is given" {
  local target_file="${BATS_TEST_TMPDIR}/target.txt"
  echo "data" >"${target_file}"

  run bash "${SCRIPT}" "${target_file}"
  assert_success
  assert_line --index 2 "target.txt"
  assert_line --index 3 --regexp '^C:\\'
}

@test "mklink: errors when a single bare target does not include a link name" {
  run bash "${SCRIPT}" target.txt
  assert_failure
  assert_output "Missing link name"
}

@test "mklink: junction links add the /j flag" {
  local target_dir="${BATS_TEST_TMPDIR}/target-dir"
  mkdir -p "${target_dir}"

  run bash "${SCRIPT}" --junction "${target_dir}" link-dir
  assert_success
  assert_line --index 2 "/j"
  assert_line --index 3 "link-dir"
}

@test "mklink: rejects WSL-backed targets" {
  run bash "${SCRIPT}" /wsl/share/file.txt link.txt
  assert_failure
  assert_output "target cannot be a WSL file"
}

@test "mklink: rejects WSL-backed link destinations" {
  local target_file="${BATS_TEST_TMPDIR}/target.txt"
  echo "data" >"${target_file}"

  run bash "${SCRIPT}" "${target_file}" /wsl/share/link.txt
  assert_failure
  assert_output "target cannot be a WSL file"
}
