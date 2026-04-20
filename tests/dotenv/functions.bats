#!/usr/bin/env bats
# Tests for dotenv/functions.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_test_bin
}

@test "functions: osc8-rewrite strips --hyperlink flags when stdout is not a tty" {
  __dot_hyperlink_scheme=""

  stub_command "argecho" <<'STUB'
#!/usr/bin/env bash
echo "$*"
STUB

  source "${REPO_ROOT}/dotenv/functions.sh"

  run internal::osc8-rewrite argecho --color=auto --hyperlink=always -la /tmp
  assert_success
  assert_output "--color=auto -la /tmp"
}

@test "functions: osc8-rewrite strips boolean --hyperlink flag when piped" {
  __dot_hyperlink_scheme=""

  stub_command "argecho" <<'STUB'
#!/usr/bin/env bash
echo "$*"
STUB

  source "${REPO_ROOT}/dotenv/functions.sh"

  run internal::osc8-rewrite argecho --hyperlink -la /tmp
  assert_success
  assert_output "-la /tmp"
}

@test "functions: osc8-rewrite preserves exit status in passthrough" {
  __dot_hyperlink_scheme=""

  stub_command "failcmd" <<'STUB'
#!/usr/bin/env bash
exit 42
STUB

  source "${REPO_ROOT}/dotenv/functions.sh"

  run internal::osc8-rewrite failcmd
  [[ "${status}" -eq 42 ]]
}

@test "functions: osc8-rewrite sed rewrites file:// URLs with empty hostname" {
  source "${REPO_ROOT}/dotenv/functions.sh"

  local result
  result=$(printf '\033]8;;file:///tmp/test\033\\hello\033]8;;\033\\\n' \
    | command sed \
      -e "s,\x1b]8;;file://[^/]*/mnt/\([a-z]\)/,\x1b]8;;__WSLDRV__/\U\1\E:/,g" \
      -e "s,\x1b]8;;file://[^/]*/,\x1b]8;;file://wsl.localhost/TestDistro/,g" \
      -e "s,__WSLDRV__/,file:///,g")
  [[ "${result}" == *"file://wsl.localhost/TestDistro/tmp/test"* ]]
}

@test "functions: osc8-rewrite sed rewrites file:// URLs with a hostname" {
  source "${REPO_ROOT}/dotenv/functions.sh"

  local result
  result=$(printf '\033]8;;file://myhost/tmp/test\033\\hello\033]8;;\033\\\n' \
    | command sed \
      -e "s,\x1b]8;;file://[^/]*/mnt/\([a-z]\)/,\x1b]8;;__WSLDRV__/\U\1\E:/,g" \
      -e "s,\x1b]8;;file://[^/]*/,\x1b]8;;file://wsl.localhost/TestDistro/,g" \
      -e "s,__WSLDRV__/,file:///,g")
  [[ "${result}" == *"file://wsl.localhost/TestDistro/tmp/test"* ]]
}

@test "functions: osc8-rewrite sed converts /mnt/d/ to native Windows file URL" {
  source "${REPO_ROOT}/dotenv/functions.sh"

  local result
  result=$(printf '\033]8;;file://myhost/mnt/d/projects/test\033\\hello\033]8;;\033\\\n' \
    | command sed \
      -e "s,\x1b]8;;file://[^/]*/mnt/\([a-z]\)/,\x1b]8;;__WSLDRV__/\U\1\E:/,g" \
      -e "s,\x1b]8;;file://[^/]*/,\x1b]8;;file://wsl.localhost/TestDistro/,g" \
      -e "s,__WSLDRV__/,file:///,g")
  [[ "${result}" == *"file:///D:/projects/test"* ]]
}

@test "functions: osc8-rewrite sed does not double-rewrite Windows mount URLs" {
  source "${REPO_ROOT}/dotenv/functions.sh"

  local result
  result=$(printf '\033]8;;file://myhost/mnt/c/Users/me\033\\hello\033]8;;\033\\\n' \
    | command sed \
      -e "s,\x1b]8;;file://[^/]*/mnt/\([a-z]\)/,\x1b]8;;__WSLDRV__/\U\1\E:/,g" \
      -e "s,\x1b]8;;file://[^/]*/,\x1b]8;;file://wsl.localhost/TestDistro/,g" \
      -e "s,__WSLDRV__/,file:///,g")
  [[ "${result}" == *"file:///C:/Users/me"* ]]
  [[ "${result}" != *"wsl.localhost"* ]]
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

@test "functions: internal::now-us returns a microsecond-resolution integer" {
  run bash -c 'source "$1"; internal::now-us' _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_success
  [[ "${output}" =~ ^[0-9]{10,}$ ]]
}

@test "functions: internal::now-us prefers EPOCHREALTIME when available" {
  [[ -n "${EPOCHREALTIME:-}" ]] || skip "EPOCHREALTIME is unavailable in this bash"

  stub_command date <<'EOF'
#!/usr/bin/env bash
exit 9
EOF

  run bash -c 'PATH="$2:/bin"; source "$1"; internal::now-us' \
    _ "${REPO_ROOT}/dotenv/functions.sh" "${MOCK_BIN}"
  assert_success
  [[ "${output}" =~ ^[0-9]{10,}$ ]]
}

@test "functions: regex extracts the full match by default" {
  command -v gawk &>/dev/null || skip "gawk not available"
  run bash -c 'source "$1"; echo "abc123def" | regex "[0-9]+"' _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_success
  assert_output "123"
}

@test "functions: regex extracts a specific capture group" {
  command -v gawk &>/dev/null || skip "gawk not available"
  run bash -c 'source "$1"; echo "abc123def" | regex "([a-z]+)([0-9]+)" 2' _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_success
  assert_output "123"
}

@test "functions: regex does not evaluate awk code embedded in the pattern" {
  command -v gawk &>/dev/null || skip "gawk not available"
  run bash -c 'source "$1"; echo "nothing" | regex "foo/; BEGIN { print \"PWN\" }; /"' \
    _ "${REPO_ROOT}/dotenv/functions.sh"
  refute_output --partial "PWN"
}

@test "functions: regex handles patterns containing forward slashes" {
  command -v gawk &>/dev/null || skip "gawk not available"
  run bash -c 'source "$1"; echo "path/to/file.txt" | regex "path/[a-z]+/[a-z]+[.]txt"' \
    _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_success
  assert_output "path/to/file.txt"
}

@test "functions: md creates and enters a single directory" {
  cd "${BATS_TEST_TMPDIR}"
  run bash -c 'source "$1"; md "$2" && pwd' _ "${REPO_ROOT}/dotenv/functions.sh" "new-dir"
  assert_success
  [[ "${output}" == *"/new-dir" ]] || {
    echo "expected pwd to end with /new-dir, got: ${output}" >&2
    return 1
  }
  [[ -d "${BATS_TEST_TMPDIR}/new-dir" ]]
}

@test "functions: md rejects being called with multiple directories" {
  cd "${BATS_TEST_TMPDIR}"
  run bash -c 'source "$1"; md "$2" "$3"' _ "${REPO_ROOT}/dotenv/functions.sh" "a" "b"
  assert_failure
  assert_output --partial "md: expected exactly one directory argument"
  [[ ! -e "${BATS_TEST_TMPDIR}/a" ]]
  [[ ! -e "${BATS_TEST_TMPDIR}/b" ]]
}

@test "functions: md rejects being called with no arguments" {
  run bash -c 'source "$1"; md' _ "${REPO_ROOT}/dotenv/functions.sh"
  assert_failure
  assert_output --partial "md: expected exactly one directory argument"
}
