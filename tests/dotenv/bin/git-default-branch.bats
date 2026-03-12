#!/usr/bin/env bats
# Tests for dotenv/bin/git-default-branch

setup() {
  load '../../helpers/common'
  SCRIPT="${REPO_ROOT}/dotenv/bin/git-default-branch"
}

@test "git-default-branch: outside a repository exits 1" {
  cd "${BATS_TEST_TMPDIR}"
  run bash "${SCRIPT}"
  assert_failure
  assert_output --partial "Not in a git repository"
}

@test "git-default-branch: returns main when a local main branch exists" {
  local repo="${BATS_TEST_TMPDIR}/repo-main"
  init_git_repo "${repo}" main
  echo "base" >"${repo}/tracked.txt"
  git_commit_all "${repo}" "initial commit"

  cd "${repo}"
  run bash "${SCRIPT}"
  assert_success
  assert_output "main"
}

@test "git-default-branch: prefers origin HEAD when the remote default branch is non-standard" {
  local remote="${BATS_TEST_TMPDIR}/origin.git"
  local seed="${BATS_TEST_TMPDIR}/seed"
  local clone_repo="${BATS_TEST_TMPDIR}/clone"

  init_bare_git_repo "${remote}" trunk
  init_git_repo "${seed}" trunk
  echo "seed" >"${seed}/tracked.txt"
  git_commit_all "${seed}" "initial commit"
  git -C "${seed}" remote add origin "${remote}"
  git -C "${seed}" push -q -u origin trunk
  git clone -q "${remote}" "${clone_repo}"

  cd "${clone_repo}"
  run bash "${SCRIPT}"
  assert_success
  assert_output "trunk"
}

@test "git-default-branch: falls back to the current branch when no main, master, or origin HEAD exists" {
  local repo="${BATS_TEST_TMPDIR}/repo-develop"
  init_git_repo "${repo}" develop
  echo "base" >"${repo}/tracked.txt"
  git_commit_all "${repo}" "initial commit"

  cd "${repo}"
  run bash "${SCRIPT}"
  assert_success
  assert_output "develop"
}
