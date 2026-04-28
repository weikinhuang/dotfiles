#!/usr/bin/env bats
# Tests for dotenv/bin/git-tag-overrides.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_isolated_home
  SCRIPT="${REPO_ROOT}/dotenv/bin/git-tag-overrides"
}

create_repo_with_origin() {
  ORIGIN_REPO="${BATS_TEST_TMPDIR}/origin.git"
  TEST_REPO="${BATS_TEST_TMPDIR}/repo"

  init_bare_git_repo "${ORIGIN_REPO}"
  init_git_repo "${TEST_REPO}"
  echo "base" >"${TEST_REPO}/tracked.txt"
  git_commit_all "${TEST_REPO}" "initial commit"
  git -C "${TEST_REPO}" remote add origin "${ORIGIN_REPO}"
}

@test "git-tag-overrides: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: git-tag-overrides"
    assert_output --partial "-r, --remote"
  done
}

@test "git-tag-overrides: outside a repository exits 1" {
  cd "${BATS_TEST_TMPDIR}"
  run bash "${SCRIPT}"
  assert_failure
  assert_output --partial "Not in a git repository"
}

@test "git-tag-overrides: adds the refspec to existing default remotes" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}"
  assert_success
  assert_output --partial "remote origin: added +refs/tags/*:refs/tags/*"

  run git -C "${TEST_REPO}" config --get-all remote.origin.fetch
  assert_success
  assert_output --partial "+refs/tags/*:refs/tags/*"
}

@test "git-tag-overrides: leaves existing fetch refspec intact when adding tags" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}"
  assert_success

  run git -C "${TEST_REPO}" config --get-all remote.origin.fetch
  assert_success
  assert_line "+refs/heads/*:refs/remotes/origin/*"
  assert_line "+refs/tags/*:refs/tags/*"
}

@test "git-tag-overrides: is idempotent on repeat runs" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}"
  assert_success

  run bash "${SCRIPT}"
  assert_success
  assert_output --partial "remote origin: already configured"

  local matches
  matches=$(git -C "${TEST_REPO}" config --get-all remote.origin.fetch \
    | grep -Fxc '+refs/tags/*:refs/tags/*')
  [[ "${matches}" -eq 1 ]]
}

@test "git-tag-overrides: skips missing default remotes silently when at least one matches" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}"
  assert_success
  refute_output --partial "upstream"

  run git -C "${TEST_REPO}" config --get-all remote.upstream.fetch
  assert_failure
}

@test "git-tag-overrides: errors when neither default remote exists" {
  local repo="${BATS_TEST_TMPDIR}/no-remote"
  init_git_repo "${repo}"
  echo "base" >"${repo}/tracked.txt"
  git_commit_all "${repo}" "initial commit"

  cd "${repo}"
  run bash "${SCRIPT}"
  assert_failure
  assert_output --partial "no matching remotes"
}

@test "git-tag-overrides: applies to an explicit remote" {
  create_repo_with_origin
  local extra="${BATS_TEST_TMPDIR}/extra.git"
  init_bare_git_repo "${extra}"
  git -C "${TEST_REPO}" remote add fork "${extra}"

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" --remote fork
  assert_success
  assert_output --partial "remote fork: added"

  run git -C "${TEST_REPO}" config --get-all remote.fork.fetch
  assert_success
  assert_output --partial "+refs/tags/*:refs/tags/*"

  run git -C "${TEST_REPO}" config --get-all remote.origin.fetch
  refute_output --partial "+refs/tags/*:refs/tags/*"
}

@test "git-tag-overrides: --remote=NAME inline form works" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" --remote=origin
  assert_success
  assert_output --partial "remote origin: added"
}

@test "git-tag-overrides: errors when an explicit remote is missing" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" --remote nope
  assert_failure
  assert_output --partial "remote nope does not exist"
}

@test "git-tag-overrides: rejects unknown arguments" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" --bogus
  assert_failure
  assert_output --partial "unknown argument"
}

@test "git-tag-overrides: rejects --remote without a value" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" --remote
  assert_failure
  assert_output --partial "missing value for --remote"
}

@test "git-tag-overrides: applies a single tag refspec" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" deploy
  assert_success
  assert_output --partial "remote origin: added +refs/tags/deploy:refs/tags/deploy"

  run git -C "${TEST_REPO}" config --get-all remote.origin.fetch
  assert_success
  assert_line "+refs/tags/deploy:refs/tags/deploy"
  refute_line "+refs/tags/*:refs/tags/*"
}

@test "git-tag-overrides: applies multiple tag refspecs" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" deploy v1.0
  assert_success
  assert_output --partial "added +refs/tags/deploy:refs/tags/deploy"
  assert_output --partial "added +refs/tags/v1.0:refs/tags/v1.0"

  run git -C "${TEST_REPO}" config --get-all remote.origin.fetch
  assert_success
  assert_line "+refs/tags/deploy:refs/tags/deploy"
  assert_line "+refs/tags/v1.0:refs/tags/v1.0"
}

@test "git-tag-overrides: per-tag adds are idempotent" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" deploy
  assert_success

  run bash "${SCRIPT}" deploy
  assert_success
  assert_output --partial "already configured (+refs/tags/deploy:refs/tags/deploy)"

  local matches
  matches=$(git -C "${TEST_REPO}" config --get-all remote.origin.fetch \
    | grep -Fxc '+refs/tags/deploy:refs/tags/deploy')
  [[ "${matches}" -eq 1 ]]
}

@test "git-tag-overrides: combines specific tags with --remote" {
  create_repo_with_origin
  local extra="${BATS_TEST_TMPDIR}/extra.git"
  init_bare_git_repo "${extra}"
  git -C "${TEST_REPO}" remote add fork "${extra}"

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" --remote fork release
  assert_success
  assert_output --partial "remote fork: added +refs/tags/release:refs/tags/release"

  run git -C "${TEST_REPO}" config --get-all remote.fork.fetch
  assert_success
  assert_line "+refs/tags/release:refs/tags/release"

  run git -C "${TEST_REPO}" config --get-all remote.origin.fetch
  refute_output --partial "+refs/tags/release"
}

@test "git-tag-overrides: rejects tag names containing slashes" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" "bad/tag"
  assert_failure
  assert_output --partial "tag must not contain"
}

@test "git-tag-overrides: -- treats following args as tag names" {
  create_repo_with_origin

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" -- --weird-tag
  assert_success
  assert_output --partial "added +refs/tags/--weird-tag:refs/tags/--weird-tag"
}
