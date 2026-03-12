#!/usr/bin/env bats
# Tests for dotenv/bin/git-diff-highlight

setup() {
  load '../../helpers/common'
  SCRIPT="${REPO_ROOT}/dotenv/bin/git-diff-highlight"
}

@test "git-diff-highlight: -h and --help print usage" {
  for flag in -h --help; do
    run perl "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: git-diff-highlight"
  done
}

@test "git-diff-highlight: leaves unmatched removals unchanged" {
  run bash -lc "printf '%s\n' '@@ -1 +1 @@' '-only old' ' context' | perl '${SCRIPT}'"
  assert_success
  assert_line --index 0 "@@ -1 +1 @@"
  assert_line --index 1 "-only old"
  assert_line --index 2 " context"
}

@test "git-diff-highlight: highlights changed characters for matching remove/add pairs" {
  run bash -lc "printf '%s\n' '@@ -1 +1 @@' '-foo bar' '+foo baz' | perl '${SCRIPT}'"
  assert_success
  assert_output --partial $'\e[7mr\e[27m'
  assert_output --partial $'\e[7mz\e[27m'
}
