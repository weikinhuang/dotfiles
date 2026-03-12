#!/usr/bin/env bats
# Tests for dotenv/bin/git-changelog

setup() {
  load '../../helpers/common'
  setup_test_bin
  prepend_path "${REPO_ROOT}/dotenv/bin"
  SCRIPT="${REPO_ROOT}/dotenv/bin/git-changelog"
}

create_repo_with_tagged_history() {
  TEST_REPO="${BATS_TEST_TMPDIR}/repo"
  init_git_repo "${TEST_REPO}"
  echo "base" >"${TEST_REPO}/tracked.txt"
  git_commit_all "${TEST_REPO}" "initial release"
  git -C "${TEST_REPO}" tag v1.0.0
  echo "second" >>"${TEST_REPO}/tracked.txt"
  git_commit_all "${TEST_REPO}" "add second change"
  echo "third" >>"${TEST_REPO}/tracked.txt"
  git_commit_all "${TEST_REPO}" "add third change"
}

@test "git-changelog: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: git-changelog"
    assert_output --partial "Options:"
    assert_output --partial "-l, --list"
  done
}

@test "git-changelog: --list prints commits since the latest tag" {
  create_repo_with_tagged_history

  cd "${TEST_REPO}"
  run bash "${SCRIPT}" --list
  assert_success
  assert_output --partial "  * add third change"
  assert_output --partial "  * add second change"
  refute_output --partial "initial release"
}

@test "git-changelog: writes a changelog header, prepends new entries, and opens the editor" {
  create_repo_with_tagged_history
  export EDITOR_LOG="${BATS_TEST_TMPDIR}/editor.log"

  stub_command editor <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >"${EDITOR_LOG}"
EOF

  echo "Older notes" >"${TEST_REPO}/CHANGELOG.md"

  cd "${TEST_REPO}"
  run env EDITOR="${MOCK_BIN}/editor" bash "${SCRIPT}" CHANGELOG.md
  assert_success
  grep -q "^n\\.n\\.n / $(date +'%Y-%m-%d')$" CHANGELOG.md
  grep -q '^==================$' CHANGELOG.md
  grep -q '^  \* add third change$' CHANGELOG.md
  grep -q '^Older notes$' CHANGELOG.md
  [[ "$(cat "${EDITOR_LOG}")" == "CHANGELOG.md" ]]
}
