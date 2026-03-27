#!/usr/bin/env bats
# Tests for config/claude/statusline-command.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
  setup_isolated_home
  SCRIPT="${REPO_ROOT}/config/claude/statusline-command.sh"

  stub_command "whoami" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'test-user'
EOF

  stub_command "hostname" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" != "-s" ]]; then
  printf 'unexpected args: %s\n' "$*" >&2
  exit 1
fi
printf '%s\n' 'test-host'
EOF
}

create_statusline_repo() {
  TEST_REPO="${BATS_TEST_TMPDIR}/repo"
  init_git_repo "${TEST_REPO}"
  echo "base" >"${TEST_REPO}/README.md"
  git_commit_all "${TEST_REPO}" "initial commit"
  git -C "${TEST_REPO}" checkout -q -b feature/statusline
}

configure_statusline_upstream() {
  ORIGIN_REPO="${BATS_TEST_TMPDIR}/origin.git"
  init_bare_git_repo "${ORIGIN_REPO}"
  git -C "${TEST_REPO}" remote add origin "${ORIGIN_REPO}"
  git -C "${TEST_REPO}" push -q -u origin feature/statusline
}

write_statusline_payload() {
  local cwd="$1"
  PAYLOAD="${BATS_TEST_TMPDIR}/payload.json"

  cat >"${PAYLOAD}" <<EOF
{
  "cwd": "${cwd}",
  "model": {
    "display_name": "Opus"
  },
  "workspace": {
    "current_dir": "${cwd}"
  },
  "cost": {
    "total_cost_usd": 0.01234
  },
  "context_window": {
    "total_input_tokens": 15234567,
    "total_output_tokens": 4521,
    "remaining_percentage": 92,
    "current_usage": {
      "input_tokens": 8500,
      "output_tokens": 1200,
      "cache_read_input_tokens": 2000
    }
  }
}
EOF
}

@test "statusline-command: formats git, context, token, session, cost, and model details" {
  create_statusline_repo
  write_statusline_payload "${TEST_REPO}"

  run env SCRIPT="${SCRIPT}" PAYLOAD="${PAYLOAD}" bash -c 'bash "${SCRIPT}" < "${PAYLOAD}"'
  assert_success
  assert_output --partial "test-user"
  assert_output --partial "test-host"
  assert_output --partial "repo"
  assert_output --partial "(feature/statusline)"
  assert_output --partial "92% left"
  assert_output --partial "8k"
  assert_output --partial "2k"
  assert_output --partial "1k"
  assert_output --partial "15.23M"
  assert_output --partial "4k"
  assert_output --partial '$0.012'
  assert_output --partial "Opus"
}

@test "statusline-command: mirrors PS1 git status markers for dirty, staged, stashed, untracked, and upstream changes" {
  create_statusline_repo
  configure_statusline_upstream

  echo "stashed" >"${TEST_REPO}/stashed.txt"
  git -C "${TEST_REPO}" add stashed.txt
  git -C "${TEST_REPO}" stash push -q -m "saved statusline state"

  echo "ahead" >"${TEST_REPO}/ahead.txt"
  git_commit_all "${TEST_REPO}" "ahead of origin"

  echo "staged" >"${TEST_REPO}/staged.txt"
  git -C "${TEST_REPO}" add staged.txt
  echo "dirty" >>"${TEST_REPO}/README.md"
  echo "untracked" >"${TEST_REPO}/untracked.txt"

  write_statusline_payload "${TEST_REPO}"

  run env SCRIPT="${SCRIPT}" PAYLOAD="${PAYLOAD}" bash -c 'bash "${SCRIPT}" < "${PAYLOAD}"'
  assert_success
  assert_output --partial "(feature/statusline *+$%>)"
}

@test "statusline-command: fmt_si abbreviates plain, thousand, and million values" {
  export DOTFILES_ROOT="${REPO_ROOT}"
  source_without_main "${SCRIPT}"

  run fmt_si 999
  assert_success
  assert_output "999"

  run fmt_si 8500
  assert_success
  assert_output "8k"

  run fmt_si 15234567
  assert_success
  assert_output "15.23M"
}
