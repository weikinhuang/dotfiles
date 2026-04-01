#!/usr/bin/env bats
# Tests for plugins/00-cd.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_isolated_home
}

@test "00-cd: defaults to HOME and defines the cd alias" {
  run bash -lc '
    source "$1"
    HOME="$2"
    mkdir -p "${HOME}"
    dirs -c
    internal::cd
    pwd
    alias cd
  ' _ "${REPO_ROOT}/plugins/00-cd.sh" "${HOME}"

  assert_success
  assert_line --index 0 "${HOME}"
  assert_line --index 1 "alias cd='internal::cd'"
}

@test "00-cd: reuses stack entries without duplicates and supports numeric history jumps" {
  local dir_a="${BATS_TEST_TMPDIR}/a"
  local dir_b="${BATS_TEST_TMPDIR}/b"
  mkdir -p "${dir_a}" "${dir_b}"

  run bash -lc '
    source "$1"
    dirs -c
    internal::cd "$2"
    internal::cd "$3"
    internal::cd "$2"
    printf "count=%s\n" "$(dirs -p | grep -Fxc "$2")"
    internal::cd -1
    printf "pwd=%s\n" "${PWD}"
    internal::cd --
  ' _ "${REPO_ROOT}/plugins/00-cd.sh" "${dir_a}" "${dir_b}"

  assert_success
  assert_line --index 0 "count=1"
  assert_line --index 1 "pwd=${dir_b}"
  assert_output --partial "${dir_b}"
  assert_output --partial "${dir_a}"
}
