#!/usr/bin/env bats
# Tests for dotenv/bin/git-sync.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
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
  git -C "${TEST_REPO}" config alias.brn 'rev-parse --abbrev-ref HEAD'
}

@test "git-sync: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: git-sync"
  done
}

@test "git-sync: restores dirty changes and returns to the starting branch after syncing origin" {
  create_origin_clone

  git -C "${TEST_REPO}" checkout -q -b feature
  echo "local change" >>"${TEST_REPO}/tracked.txt"

  cd "${TEST_REPO}"
  run env GIT_SYNC_TRACE=1 bash "${SCRIPT}"
  assert_success
  assert_output --partial "Checkout to main"
  assert_output --partial "Pulling origin"

  [[ "$(git rev-parse --abbrev-ref HEAD)" == "feature" ]]
  grep -q 'local change' tracked.txt

  run git status --porcelain -- tracked.txt
  assert_success
  assert_output " M tracked.txt"
}

@test "git-sync: prefers upstream pulls when an upstream remote exists" {
  source_without_main "${SCRIPT}"
  export GIT_SYNC_LOG="${BATS_TEST_TMPDIR}/git-sync.log"
  export MOCK_GIT_HAS_UPSTREAM=1

  stub_command git-default-branch <<'EOF'
#!/usr/bin/env bash
echo main
EOF

  stub_command git <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${GIT_SYNC_LOG}"
case "${1:-}" in
  brn)
    echo feature
    ;;
  diff-index)
    exit 0
    ;;
  remote)
    if [[ "${2:-}" == "-v" ]]; then
      printf '%s\n' 'origin mock'
      if [[ -n "${MOCK_GIT_HAS_UPSTREAM:-}" ]]; then
        printf '%s\n' 'upstream mock'
      fi
    fi
    ;;
  stash)
    if [[ "${2:-}" == "list" ]]; then
      printf '%s\n' ''
    fi
    ;;
esac
EOF

  run sync_one
  assert_success
  grep -Fx 'pull upstream main' "${GIT_SYNC_LOG}"
  grep -Fx 'push origin main' "${GIT_SYNC_LOG}"
}
