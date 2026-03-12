#!/usr/bin/env bats
# Tests for dotenv/bin/git-branch-prune

setup() {
  load '../../helpers/common'
  prepend_path "${REPO_ROOT}/dotenv/bin"
  SCRIPT="${REPO_ROOT}/dotenv/bin/git-branch-prune"
}

create_origin_clone() {
  ORIGIN_REPO="${BATS_TEST_TMPDIR}/origin.git"
  SEED_REPO="${BATS_TEST_TMPDIR}/seed"
  TEST_REPO="${BATS_TEST_TMPDIR}/repo"

  init_bare_git_repo "${ORIGIN_REPO}"
  init_git_repo "${SEED_REPO}"
  echo "base" >"${SEED_REPO}/tracked.txt"
  git_commit_all "${SEED_REPO}" "initial commit"
  git -C "${SEED_REPO}" remote add origin "${ORIGIN_REPO}"
  git -C "${SEED_REPO}" push -q -u origin main
  git clone -q "${ORIGIN_REPO}" "${TEST_REPO}"
  configure_git_identity "${TEST_REPO}"
}

@test "git-branch-prune: exits when origin is not pushable" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  init_git_repo "${repo}"
  echo "base" >"${repo}/tracked.txt"
  git_commit_all "${repo}" "initial commit"

  cd "${repo}"
  run bash "${SCRIPT}"
  assert_failure
  assert_output --partial "pushable \"origin\" remote"
}

@test "git-branch-prune: removes merged branches locally and from origin" {
  create_origin_clone

  git -C "${TEST_REPO}" checkout -q -b merged-feature
  echo "merged" >"${TEST_REPO}/merged.txt"
  git_commit_all "${TEST_REPO}" "merged feature"
  git -C "${TEST_REPO}" push -q -u origin merged-feature
  git -C "${TEST_REPO}" checkout -q main
  git -C "${TEST_REPO}" merge -q --no-ff merged-feature -m "merge merged feature"
  git -C "${TEST_REPO}" push -q origin main

  git -C "${TEST_REPO}" checkout -q -b unmerged-feature
  echo "unmerged" >"${TEST_REPO}/unmerged.txt"
  git_commit_all "${TEST_REPO}" "unmerged feature"
  git -C "${TEST_REPO}" push -q -u origin unmerged-feature
  git -C "${TEST_REPO}" checkout -q main

  cd "${TEST_REPO}"
  run bash "${SCRIPT}"
  assert_success
  assert_output --partial 'Pruned "merged-feature"; removing from origin... Removed.'

  run git -C "${TEST_REPO}" show-ref --verify --quiet refs/heads/merged-feature
  assert_failure
  git -C "${TEST_REPO}" show-ref --verify --quiet refs/heads/unmerged-feature
  run git -C "${TEST_REPO}" ls-remote --exit-code --heads origin merged-feature >/dev/null 2>&1
  assert_failure
  git -C "${TEST_REPO}" ls-remote --exit-code --heads origin unmerged-feature >/dev/null 2>&1
}
