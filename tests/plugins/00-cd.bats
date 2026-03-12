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
    __cd_func
    pwd
    alias cd
  ' _ "${REPO_ROOT}/plugins/00-cd.sh" "${HOME}"

  assert_success
  assert_line --index 0 "${HOME}"
  assert_line --index 1 "alias cd='__cd_func'"
}

@test "00-cd: reuses stack entries without duplicates and supports numeric history jumps" {
  local dir_a="${BATS_TEST_TMPDIR}/a"
  local dir_b="${BATS_TEST_TMPDIR}/b"
  mkdir -p "${dir_a}" "${dir_b}"

  run bash -lc '
    source "$1"
    dirs -c
    __cd_func "$2"
    __cd_func "$3"
    __cd_func "$2"
    printf "count=%s\n" "$(dirs -p | grep -Fxc "$2")"
    __cd_func -1
    printf "pwd=%s\n" "${PWD}"
    __cd_func --
  ' _ "${REPO_ROOT}/plugins/00-cd.sh" "${dir_a}" "${dir_b}"

  assert_success
  assert_line --index 0 "count=1"
  assert_line --index 1 "pwd=${dir_b}"
  assert_output --partial "${dir_b}"
  assert_output --partial "${dir_a}"
}
