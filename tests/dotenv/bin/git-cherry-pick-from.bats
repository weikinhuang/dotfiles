#!/usr/bin/env bats
# Tests for dotenv/bin/git-cherry-pick-from

setup() {
  load '../../helpers/common'
  add_git_exec_path
  SCRIPT="${REPO_ROOT}/dotenv/bin/git-cherry-pick-from"
}

create_source_and_dest_repos() {
  SOURCE_REPO="${BATS_TEST_TMPDIR}/source"
  DEST_REPO="${BATS_TEST_TMPDIR}/dest"

  init_git_repo "${SOURCE_REPO}"
  echo "base" >"${SOURCE_REPO}/README.md"
  git_commit_all "${SOURCE_REPO}" "source base"
  echo "picked" >"${SOURCE_REPO}/picked.txt"
  echo "skipped" >"${SOURCE_REPO}/skipped.txt"
  git_commit_all "${SOURCE_REPO}" "add picked files"
  PICKED_SHA="$(git -C "${SOURCE_REPO}" rev-parse HEAD)"

  init_git_repo "${DEST_REPO}"
  echo "base" >"${DEST_REPO}/README.md"
  git_commit_all "${DEST_REPO}" "dest base"
}

@test "git-cherry-pick-from: exits when the other repo does not exist" {
  local repo="${BATS_TEST_TMPDIR}/dest"
  init_git_repo "${repo}"
  echo "base" >"${repo}/README.md"
  git_commit_all "${repo}" "dest base"

  cd "${repo}"
  run bash "${SCRIPT}" "${BATS_TEST_TMPDIR}/missing-repo" deadbeef
  assert_failure
}

@test "git-cherry-pick-from: applies only the requested paths from another repository" {
  create_source_and_dest_repos

  cd "${DEST_REPO}"
  run bash "${SCRIPT}" "${SOURCE_REPO}" "${PICKED_SHA}" -- picked.txt
  assert_success
  [[ -f picked.txt ]]
  [[ ! -e skipped.txt ]]

  run git log --format=%s -1
  assert_success
  assert_output "add picked files"
}
