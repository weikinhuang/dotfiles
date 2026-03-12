#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/winstart

setup() {
  load '../../../helpers/common'
  setup_mock_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/winstart"

  # A real file for path-translation tests
  TEST_FILE="${BATS_TEST_TMPDIR}/sample.txt"
  echo "content" >"${TEST_FILE}"
}

# ---------------------------------------------------------------------------
# usage / error handling
# ---------------------------------------------------------------------------

@test "winstart: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: winstart [OPTION]... COMMAND [ARG...]"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "winstart: no arguments prints usage to stderr and exits 1" {
  run bash "${SCRIPT}"
  assert_failure
  assert_output --partial "Usage:"
}

# ---------------------------------------------------------------------------
# Start-Process command construction
# ---------------------------------------------------------------------------

@test "winstart: single command produces Start-Process -FilePath only" {
  run bash "${SCRIPT}" notepad.exe
  assert_success
  # The -Command value is the last line from the mock
  assert_line --regexp "Start-Process -FilePath 'notepad\.exe'$"
}

@test "winstart: command with one arg produces Start-Process with -ArgumentList" {
  run bash "${SCRIPT}" notepad.exe somefile.txt
  assert_success
  assert_line --regexp "Start-Process -FilePath 'notepad\.exe' -ArgumentList 'somefile\.txt'"
}

@test "winstart: command with multiple args produces comma-separated -ArgumentList" {
  run bash "${SCRIPT}" cmd.exe /c echo hello
  assert_success
  assert_line --regexp "Start-Process -FilePath 'cmd\.exe' -ArgumentList '/c', 'echo', 'hello'"
}

# ---------------------------------------------------------------------------
# WSL path translation
# ---------------------------------------------------------------------------

@test "winstart: existing file argument is translated to a Windows path" {
  run bash "${SCRIPT}" notepad.exe "${TEST_FILE}"
  assert_success
  # Translated path in -ArgumentList (contains backslash)
  assert_line --regexp "ArgumentList.*\\\\"
}

@test "winstart: translated path uses Windows drive-letter format" {
  run bash "${SCRIPT}" notepad.exe "${TEST_FILE}"
  assert_success
  assert_line --regexp "ArgumentList 'C:\\\\"
}

@test "winstart: command itself is translated if it is an existing file" {
  run bash "${SCRIPT}" "${TEST_FILE}"
  assert_success
  assert_line --regexp "Start-Process -FilePath 'C:\\\\"
}

@test "winstart: single-letter root path is excluded from translation" {
  run bash "${SCRIPT}" notepad.exe /c
  assert_success
  assert_line --regexp "ArgumentList '/c'"
}

# ---------------------------------------------------------------------------
# Special character escaping (PS single-quote: ' → '')
# ---------------------------------------------------------------------------

@test "winstart: single quote in argument is escaped as ''" {
  run bash "${SCRIPT}" "it's notepad"
  assert_success
  assert_line --regexp "FilePath 'it''s notepad'"
}

@test "winstart: single quote in extra argument is escaped as ''" {
  run bash "${SCRIPT}" notepad.exe "file's name.txt"
  assert_success
  assert_line --regexp "ArgumentList 'file''s name\.txt'"
}

@test "winstart: multiple single quotes are all escaped" {
  run bash "${SCRIPT}" "it's a 'test'"
  assert_success
  assert_line --regexp "FilePath 'it''s a ''test'''"
}

# ---------------------------------------------------------------------------
# URLs and special shell characters
# ---------------------------------------------------------------------------

@test "winstart: URL with query string and ampersand passes through safely" {
  run bash "${SCRIPT}" "https://example.com?foo=bar&baz=1"
  assert_success
  assert_line --regexp "FilePath 'https://example\.com\?foo=bar&baz=1'"
}

@test "winstart: URL with no args opens via Start-Process -FilePath only" {
  run bash "${SCRIPT}" "https://github.com/weikinhuang/dotfiles"
  assert_success
  assert_line --regexp "Start-Process -FilePath 'https://github\.com/weikinhuang/dotfiles'$"
}

# ---------------------------------------------------------------------------
# Flags passed to powershell.exe
# ---------------------------------------------------------------------------

@test "winstart: powershell is invoked with -NoProfile -NonInteractive" {
  run bash "${SCRIPT}" notepad.exe
  assert_success
  assert_line "-NoProfile"
  assert_line "-NonInteractive"
}
