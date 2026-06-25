#!/usr/bin/env bats
# Tests for dotenv/wsl/bin/quick-toast.
# SPDX-License-Identifier: MIT

setup() {
  load '../../../helpers/common'
  setup_test_bin
  SCRIPT="${REPO_ROOT}/dotenv/wsl/bin/quick-toast"
}

@test "quick-toast: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: quick-toast [OPTION]... [TITLE] [BODY]"
    assert_output --partial "Options:"
    assert_output --partial "-h, --help"
  done
}

@test "quick-toast: uses the default alert text when no title is provided" {
  stub_passthrough_command powershell.exe
  run bash "${SCRIPT}"
  assert_success
  assert_line "-NoProfile"
  assert_line "-EncodedCommand"
  decoded=$(printf '%s' "${lines[-1]}" | base64 -d | iconv -f UTF-16LE -t UTF-8)
  [[ "${decoded}" == *'$TITLE = "ALERT FROM TERMINAL"'* ]]
  [[ "${decoded}" == *'$BODY = ""'* ]]
}

@test "quick-toast: escapes quotes and backticks in title and body" {
  stub_passthrough_command powershell.exe
  run bash "${SCRIPT}" 'a"b' 'c`d'
  assert_success
  decoded=$(printf '%s' "${lines[-1]}" | base64 -d | iconv -f UTF-16LE -t UTF-8)
  [[ "${decoded}" == *'$TITLE = "a`"b"'* ]]
  [[ "${decoded}" == *'$BODY = "c``d"'* ]]
}

@test "quick-toast: preserves UTF-8 characters in the encoded command" {
  stub_passthrough_command powershell.exe
  run bash "${SCRIPT}" 'π·' 'café'
  assert_success
  decoded=$(printf '%s' "${lines[-1]}" | base64 -d | iconv -f UTF-16LE -t UTF-8)
  [[ "${decoded}" == *'$TITLE = "π·"'* ]]
  [[ "${decoded}" == *'$BODY = "café"'* ]]
}
