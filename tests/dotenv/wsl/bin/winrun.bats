#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/winrun

setup() {
  load '../../../helpers/common'
  setup_mock_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/winrun"

  # A real file for path-translation tests
  TEST_FILE="${BATS_TEST_TMPDIR}/sample.txt"
  echo "content" >"${TEST_FILE}"
}

# ---------------------------------------------------------------------------
# usage / error handling
# ---------------------------------------------------------------------------

@test "winrun: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: winrun [OPTION]... COMMAND [ARG...]"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "winrun: no arguments prints usage to stderr and exits 1" {
  run bash "${SCRIPT}"
  assert_failure
  assert_output --partial "Usage:"
}

# ---------------------------------------------------------------------------
# argument passthrough
# ---------------------------------------------------------------------------

@test "winrun: non-file argument is passed through unchanged" {
  run bash "${SCRIPT}" echo hello
  assert_success
  assert_line --index 0 "/c"
  assert_line --index 1 "echo"
  assert_line --index 2 "hello"
}

@test "winrun: multiple non-file arguments all pass through unchanged" {
  run bash "${SCRIPT}" echo foo bar baz
  assert_success
  assert_line --index 0 "/c"
  assert_line --index 1 "echo"
  assert_line --index 2 "foo"
  assert_line --index 3 "bar"
  assert_line --index 4 "baz"
}

# ---------------------------------------------------------------------------
# WSL path translation
# ---------------------------------------------------------------------------

@test "winrun: existing file argument is translated to a Windows path" {
  run bash "${SCRIPT}" type "${TEST_FILE}"
  assert_success
  assert_line --index 0 "/c"
  assert_line --index 1 "type"
  # Translated path must contain a backslash
  assert_line --index 2 --regexp '\\'
}

@test "winrun: translated path uses Windows drive-letter format" {
  # TEST_FILE is under /tmp/... which the mock maps to C:\tmp\...
  run bash "${SCRIPT}" type "${TEST_FILE}"
  assert_success
  assert_line --index 2 --regexp '^C:\\'
}

@test "winrun: single-letter root path is excluded from translation" {
  # /c matches ^/[a-z]$ and must never be passed to wslpath
  run bash "${SCRIPT}" dir /c
  assert_success
  assert_line --index 2 "/c"
}

@test "winrun: mixed args translates existing files, leaves others unchanged" {
  run bash "${SCRIPT}" type "${TEST_FILE}" plain-arg
  assert_success
  # File → Windows path (contains backslash)
  assert_line --index 2 --regexp '\\'
  # Plain arg → unchanged
  assert_line --index 3 "plain-arg"
}

@test "winrun: non-existent path is passed through unchanged" {
  run bash "${SCRIPT}" echo /no/such/path
  assert_success
  assert_line --index 2 "/no/such/path"
}

# ---------------------------------------------------------------------------
# stdin passthrough
# ---------------------------------------------------------------------------

@test "winrun: stdin is forwarded to the child process" {
  setup_mock_cmd_stdin
  run bash -c "printf 'piped-content' | bash '${SCRIPT}' passthrough"
  assert_success
  assert_output --partial "piped-content"
}
