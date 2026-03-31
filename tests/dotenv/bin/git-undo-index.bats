#!/usr/bin/env bats
# Tests for dotenv/bin/git-undo-index.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_isolated_home
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
  local branch_name
  local head_before
  local undo_commit

  init_git_repo "${repo}"
  echo "tracked original" >"${repo}/tracked.txt"
  echo "keep original" >"${repo}/keep.txt"
  git_commit_all "${repo}" "initial commit"
  head_before="$(git -C "${repo}" rev-parse HEAD)"

  echo "tracked changed" >"${repo}/tracked.txt"
  echo "keep changed" >"${repo}/keep.txt"

  cd "${repo}"
  run bash "${SCRIPT}" tracked.txt
  assert_success
  branch_name="$(git rev-parse --abbrev-ref HEAD)"
  [[ "$(cat tracked.txt)" == "tracked original" ]]
  [[ "$(cat keep.txt)" == "keep changed" ]]
  [[ "$(git rev-parse HEAD)" == "${head_before}" ]]

  run git status --porcelain
  assert_success
  assert_output " M keep.txt"

  run git reflog --grep-reflog='Undoing changes for' --format='%H' -n 1
  assert_success
  undo_commit="${output}"

  run git reflog --grep-reflog='Undoing changes for' --format='%H'
  assert_success
  assert_output "${undo_commit}"

  run git reflog --grep-reflog='git-undo-index: restore HEAD'
  assert_success
  assert_output ""

  run git reflog show "${branch_name}" --grep-reflog='Undoing changes for' --format='%H'
  assert_success
  assert_output "${undo_commit}"

  run git reflog show "${branch_name}" --grep-reflog='git-undo-index: restore HEAD'
  assert_success
  assert_output ""

  run git show "${undo_commit}:tracked.txt"
  assert_success
  assert_output "tracked changed"
}

@test "git-undo-index: discards staged added files and keeps other tracked changes" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  local undo_commit

  init_git_repo "${repo}"
  echo "keep original" >"${repo}/keep.txt"
  git_commit_all "${repo}" "initial commit"

  echo "added content" >"${repo}/added.txt"
  git -C "${repo}" add added.txt
  echo "keep changed" >"${repo}/keep.txt"

  cd "${repo}"
  run bash "${SCRIPT}" added.txt
  assert_success
  [[ ! -e added.txt ]]
  [[ "$(cat keep.txt)" == "keep changed" ]]

  run git status --porcelain
  assert_success
  assert_output " M keep.txt"

  run git reflog --grep-reflog='Undoing changes for' --format='%H' -n 1
  assert_success
  undo_commit="${output}"

  run git show "${undo_commit}:added.txt"
  assert_success
  assert_output "added content"
}

@test "git-undo-index: with no paths restores all tracked changes without adding reset reflog noise" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  local head_before
  local undo_commit

  init_git_repo "${repo}"
  echo "tracked original" >"${repo}/tracked.txt"
  git_commit_all "${repo}" "initial commit"
  head_before="$(git -C "${repo}" rev-parse HEAD)"

  echo "tracked changed" >"${repo}/tracked.txt"
  echo "staged content" >"${repo}/added.txt"
  git -C "${repo}" add added.txt
  echo "scratch" >"${repo}/scratch.txt"

  cd "${repo}"
  run bash "${SCRIPT}"
  assert_success
  [[ "$(cat tracked.txt)" == "tracked original" ]]
  [[ ! -e added.txt ]]
  [[ "$(cat scratch.txt)" == "scratch" ]]
  [[ "$(git rev-parse HEAD)" == "${head_before}" ]]

  run git status --porcelain --untracked-files=all
  assert_success
  assert_output "?? scratch.txt"

  run git reflog --grep-reflog='Undoing changes for' --format='%H'
  assert_success
  [[ "${#lines[@]}" -eq 1 ]]
  undo_commit="${lines[0]}"

  run git reflog --grep-reflog='git-undo-index: restore HEAD'
  assert_success
  assert_output ""

  run git reflog --grep-reflog='reset: moving to HEAD'
  assert_success
  assert_output ""

  run git show "${undo_commit}:tracked.txt"
  assert_success
  assert_output "tracked changed"

  run git show "${undo_commit}:added.txt"
  assert_success
  assert_output "staged content"
}
