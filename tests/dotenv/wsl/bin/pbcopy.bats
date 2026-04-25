#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/pbcopy.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/pbcopy"
}

@test "pbcopy: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: pbcopy"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "pbcopy: pipes stdin through powershell Set-Clipboard without touching clip.exe" {
  # clip.exe mishandles both BOM-less short ASCII (IsTextUnicode() false
  # positive, e.g. "1\n" -> ਱) and BOM-prefixed UTF-16 (leaves the BOM in the
  # clipboard). Set-Clipboard on the PowerShell side avoids both failure modes.
  local ps_stdin_file="${BATS_TEST_TMPDIR}/powershell.stdin"
  export PS_STDIN_FILE="${ps_stdin_file}"
  stub_command "powershell.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
cat >"${PS_STDIN_FILE}"
EOF
  stub_command "clip.exe" <<'EOF'
#!/usr/bin/env bash
echo "clip.exe should not be invoked" >&2
exit 99
EOF

  run bash -c "printf '1\n' | bash '${SCRIPT}'"
  assert_success
  assert_line --index 0 "-NoProfile"
  assert_line --index 1 "-NonInteractive"
  assert_line --index 2 "-Command"
  assert_output --partial "Set-Clipboard"
  assert_output --partial "[Console]::InputEncoding = [Text.Encoding]::UTF8"

  run cat "${ps_stdin_file}"
  assert_success
  assert_output $'1'
}
