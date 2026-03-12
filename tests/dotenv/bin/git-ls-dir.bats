#!/usr/bin/env bats
# Tests for dotenv/bin/git-ls-dir.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  SCRIPT="${REPO_ROOT}/dotenv/bin/git-ls-dir"
  REPO="${BATS_TEST_TMPDIR}/repo"
  init_git_repo "${REPO}"
  mkdir -p "${REPO}/lib"
  printf 'one\n' >"${REPO}/lib/example.txt"
  git_commit_all "${REPO}" "add lib file"
  printf 'two\n' >"${REPO}/lib/example.txt"
  git_commit_all "${REPO}" "update lib file"
  SHORT_SHA="$(git -C "${REPO}" rev-parse --short=8 HEAD)"
}

@test "git-ls-dir: -h and --help print usage" {
  for flag in -h --help; do
    run perl "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: git-ls-dir"
    assert_output --partial "-c, --commitish COMMIT-ISH"
  done
}

@test "git-ls-dir: missing tree entries abort with a helpful error" {
  run bash -c "cd '${REPO}' && perl '${SCRIPT}' missing/"
  assert_failure
  assert_output --partial "did not return any files; aborting"
}

@test "git-ls-dir: lists tracked files with commit metadata" {
  run bash -c "cd '${REPO}' && perl '${SCRIPT}' lib/"
  assert_success
  assert_output --partial "${SHORT_SHA}"
  assert_output --partial "Test User"
  assert_output --partial "lib/example.txt"
  assert_output --partial "[update lib file]"
}
