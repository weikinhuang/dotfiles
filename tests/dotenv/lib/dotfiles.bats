#!/usr/bin/env bats
# Tests for dotenv/lib/dotfiles.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
}

@test "dotfiles: dotfiles-profile rejects filters without trace mode" {
  run bash -c 'source "$1"; dotfiles-profile --filter git' _ "${REPO_ROOT}/dotenv/lib/dotfiles.sh"
  assert_failure
  assert_output --partial "--filter/--exclude require --trace"
}

@test "dotfiles: dotfiles-prompt-profile requires an interactive prompt" {
  run bash -c 'source "$1"; unset PS1; dotfiles-prompt-profile' _ "${REPO_ROOT}/dotenv/lib/dotfiles.sh"
  assert_failure
  assert_output --partial "no PS1 found"
}

@test "dotfiles: internal::now-us returns a microsecond-resolution integer" {
  run bash -c 'source "$1"; internal::now-us' _ "${REPO_ROOT}/dotenv/lib/dotfiles.sh"
  assert_success
  [[ "${output}" =~ ^[0-9]{10,}$ ]]
}

@test "dotfiles: internal::now-us prefers EPOCHREALTIME when available" {
  [[ -n "${EPOCHREALTIME:-}" ]] || skip "EPOCHREALTIME is unavailable in this bash"

  stub_command date <<'EOF'
#!/usr/bin/env bash
exit 9
EOF

  run bash -c 'PATH="$2:/bin"; source "$1"; internal::now-us' \
    _ "${REPO_ROOT}/dotenv/lib/dotfiles.sh" "${MOCK_BIN}"
  assert_success
  [[ "${output}" =~ ^[0-9]{10,}$ ]]
}
