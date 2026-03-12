#!/usr/bin/env bats

setup() {
  load '../helpers/common'
  setup_test_bin
}

@test "functions: parallel-xargs requires a command" {
  run bash -c 'source "$1"; parallel-xargs' _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_failure
  assert_output --partial "Usage: parallel-xargs <command> [args...]"
}

@test "functions: parallel-xargs appends the placeholder when omitted" {
  run bash -c 'source "$1"; export PROC_CORES=1; printf "%s\n" alpha beta | parallel-xargs printf "<%s>\n"' \
    _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_success
  assert_output $'<alpha>\n<beta>'
}

@test "functions: parallel-xargs preserves an explicit placeholder" {
  run bash -c 'source "$1"; export PROC_CORES=1; printf "%s\n" alpha beta | parallel-xargs printf "<%s:%s>\n" prefix "{}"' \
    _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_success
  assert_output $'<prefix:alpha>\n<prefix:beta>'
}

@test "functions: extract rejects missing files before checking archive type" {
  local archive="${BATS_TEST_TMPDIR}/missing.zip"

  run bash -c 'source "$1"; extract "$2"' _ "${REPO_ROOT}/dotenv/functions.sh" "${archive}"
  assert_failure
  assert_output --partial "is not a valid file"
}

@test "functions: extract rejects unsupported archive extensions" {
  local archive="${BATS_TEST_TMPDIR}/archive.unsupported"
  touch "${archive}"

  run bash -c 'source "$1"; extract "$2"' _ "${REPO_ROOT}/dotenv/functions.sh" "${archive}"
  assert_failure
  assert_output --partial "cannot be extracted via extract()"
}

@test "functions: extract reports missing archive tools for supported extensions" {
  local archive="${BATS_TEST_TMPDIR}/archive.7z"
  touch "${archive}"

  run bash -c 'PATH="$2:/bin"; source "$1"; extract "$3"' \
    _ "${REPO_ROOT}/dotenv/functions.sh" "${MOCK_BIN}" "${archive}"
  assert_failure
  assert_output --partial "extract: '7z' is not installed"
}

@test "functions: date2unix parses explicit UTC dates" {
  run bash -c 'source "$1"; date2unix 1970-01-02 UTC' _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_success
  assert_output "86400"
}

@test "functions: date2unix reports parse failures after all fallbacks are exhausted" {
  run bash -c 'source "$1"; date2unix definitely not a real date' _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_failure
  assert_output --partial "date2unix: unable to parse"
}

@test "functions: dotfiles-profile rejects filters without trace mode" {
  run bash -c 'source "$1"; dotfiles-profile --filter git' _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_failure
  assert_output --partial "--filter/--exclude require --trace"
}

@test "functions: dotfiles-prompt-profile requires an interactive prompt" {
  run bash -c 'source "$1"; unset PS1; dotfiles-prompt-profile' _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_failure
  assert_output --partial "no PS1 found"
}

@test "functions: __dot_now_us returns a microsecond-resolution integer" {
  run bash -c 'source "$1"; __dot_now_us' _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_success
  [[ "${output}" =~ ^[0-9]{10,}$ ]]
}

@test "functions: __dot_now_us prefers EPOCHREALTIME when available" {
  [[ -n "${EPOCHREALTIME:-}" ]] || skip "EPOCHREALTIME is unavailable in this bash"

  stub_command date <<'EOF'
#!/usr/bin/env bash
exit 9
EOF

  run bash -c 'PATH="$2:/bin"; source "$1"; __dot_now_us' \
    _ "${REPO_ROOT}/dotenv/functions.sh" "${MOCK_BIN}"
  assert_success
  [[ "${output}" =~ ^[0-9]{10,}$ ]]
}
