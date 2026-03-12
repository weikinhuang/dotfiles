#!/usr/bin/env bats
# Tests for dotenv/bin/git-ignore

setup() {
  load '../../helpers/common'
  setup_isolated_home
  SCRIPT="${REPO_ROOT}/dotenv/bin/git-ignore"
  git config --global core.excludesfile "${HOME}/.gitignore_global"
}

@test "git-ignore: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: git-ignore"
    assert_output --partial "-l, --local"
    assert_output --partial "-g, --global"
  done
}

@test "git-ignore: no arguments show both global and local ignore files" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  mkdir -p "${repo}"
  echo "*.log" >"${HOME}/.gitignore_global"
  echo "*.tmp" >"${repo}/.gitignore"

  cd "${repo}"
  run bash "${SCRIPT}"
  assert_success
  assert_output --partial "Global gitignore: ${HOME}/.gitignore_global"
  assert_output --partial "*.log"
  assert_output --partial "Local gitignore: .gitignore"
  assert_output --partial "*.tmp"
}

@test "git-ignore: default mode adds local patterns without duplicates" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  mkdir -p "${repo}"

  cd "${repo}"
  run bash "${SCRIPT}" "*.log" "*.log" "*.tmp"
  assert_success
  assert_output --partial "Adding pattern(s) to: .gitignore"
  [[ "$(grep -Fxc '*.log' .gitignore)" -eq 1 ]]
  [[ "$(grep -Fxc '*.tmp' .gitignore)" -eq 1 ]]
}

@test "git-ignore: --global adds patterns to the configured global ignores file" {
  cd "${BATS_TEST_TMPDIR}"
  run bash "${SCRIPT}" --global ".DS_Store" "Thumbs.db"
  assert_success
  [[ "$(grep -Fxc '.DS_Store' "${HOME}/.gitignore_global")" -eq 1 ]]
  [[ "$(grep -Fxc 'Thumbs.db' "${HOME}/.gitignore_global")" -eq 1 ]]
}
