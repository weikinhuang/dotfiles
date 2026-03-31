#!/usr/bin/env bats
# Tests for dotenv/bin/git-sync.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
  setup_isolated_home
  prepend_path "${REPO_ROOT}/dotenv/bin"
  SCRIPT="${REPO_ROOT}/dotenv/bin/git-sync"
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

@test "git-sync: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: git-sync"
    assert_output --partial "-v, --verbose"
  done
}

@test "git-sync: -v prints sync progress while restoring dirty changes" {
  create_origin_clone

  git -C "${TEST_REPO}" checkout -q -b feature
  echo "local change" >>"${TEST_REPO}/tracked.txt"

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" -v
  assert_success
  assert_output --partial "Checkout to main"
  assert_output --partial "Pulling origin"

  [[ "$(git rev-parse --abbrev-ref HEAD)" == "feature" ]]
  grep -q 'local change' tracked.txt

  run git status --porcelain -- tracked.txt
  assert_success
  assert_output " M tracked.txt"
}

@test "git-sync: restores staged changes after syncing origin" {
  create_origin_clone

  git -C "${TEST_REPO}" checkout -q -b feature
  echo "staged change" >>"${TEST_REPO}/tracked.txt"
  git -C "${TEST_REPO}" add tracked.txt

  cd "${TEST_REPO}"
  run bash "${SCRIPT}"
  assert_success

  [[ "$(git rev-parse --abbrev-ref HEAD)" == "feature" ]]
  grep -q 'staged change' tracked.txt

  run git status --porcelain -- tracked.txt
  assert_success
  assert_output "M  tracked.txt"
}

@test "git-sync: restores untracked files that conflict with files added on the default branch" {
  create_origin_clone

  git -C "${TEST_REPO}" checkout -q -b feature
  echo "local scratch" >"${TEST_REPO}/conflict.txt"

  echo "remote tracked" >"${SEED_REPO}/conflict.txt"
  git_commit_all "${SEED_REPO}" "add conflict file"
  git -C "${SEED_REPO}" push -q origin main

  cd "${TEST_REPO}"
  run bash "${SCRIPT}"
  assert_success

  [[ "$(git rev-parse --abbrev-ref HEAD)" == "feature" ]]
  [[ "$(cat conflict.txt)" == "local scratch" ]]

  run git status --porcelain --untracked-files=all -- conflict.txt
  assert_success
  assert_output "?? conflict.txt"
}

@test "git-sync: prefers upstream pulls when an upstream remote exists" {
  source_without_main "${SCRIPT}"
  export GIT_SYNC_LOG="${BATS_TEST_TMPDIR}/git-sync.log"
  export MOCK_GIT_HAS_UPSTREAM=1

  stub_command git <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${GIT_SYNC_LOG}"
case "${1:-}" in
  symbolic-ref)
    if [[ "${3:-}" == "refs/remotes/origin/HEAD" ]]; then
      echo refs/remotes/origin/main
    else
      echo feature
    fi
    ;;
  status)
    exit 0
    ;;
  remote)
    if [[ "${2:-}" == "get-url" && "${3:-}" == "upstream" ]]; then
      if [[ -n "${MOCK_GIT_HAS_UPSTREAM:-}" ]]; then
        echo https://example.com/upstream.git
        exit 0
      fi
      exit 2
    fi
    ;;
esac
EOF

  run sync_one
  assert_success
  grep -F -- 'pull --ff-only upstream main' "${GIT_SYNC_LOG}"
  grep -F -- 'push origin main' "${GIT_SYNC_LOG}"
}
