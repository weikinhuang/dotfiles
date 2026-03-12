#!/usr/bin/env bats
# Tests for dotenv/bin/git-undo-index.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  SCRIPT="${REPO_ROOT}/dotenv/bin/git-undo-index"
}

@test "git-undo-index: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: git-undo-index"
  done
}

@test "git-undo-index: reverts only the requested paths and leaves other changes intact" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  init_git_repo "${repo}"
  echo "tracked original" >"${repo}/tracked.txt"
  echo "keep original" >"${repo}/keep.txt"
  git_commit_all "${repo}" "initial commit"
  local head_before
  head_before="$(git -C "${repo}" rev-parse HEAD)"

  echo "tracked changed" >"${repo}/tracked.txt"
  echo "keep changed" >"${repo}/keep.txt"

  cd "${repo}"
  run bash "${SCRIPT}" tracked.txt
  assert_success
  [[ "$(cat tracked.txt)" == "tracked original" ]]
  [[ "$(cat keep.txt)" == "keep changed" ]]
  [[ "$(git rev-parse HEAD)" == "${head_before}" ]]

  run git status --porcelain
  assert_success
  assert_output " M keep.txt"

  run git reflog --grep-reflog='Undoing changes for'
  assert_success
  assert_output --partial "Undoing changes for"
}
