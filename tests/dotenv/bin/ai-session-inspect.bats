#!/usr/bin/env bats
# SPDX-License-Identifier: MIT
setup() {
  load '../../helpers/common'
  setup_test_bin
  TOOL="${REPO_ROOT}/dotenv/bin/ai-session-inspect"
}

@test "ai-session-inspect: help is local and states the metadata-only contract" {
  for flag in -h --help; do
    run bash "${TOOL}" "${flag}"
    assert_success
    assert_output --partial 'Usage: ai-session-inspect'
    assert_output --partial 'Never prints message'
  done
}

@test "ai-session-inspect: delegates arguments unchanged to the local node CLI" {
  stub_command node <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
  run bash "${TOOL}" 019f0109 --all --user-dir=/tmp/sessions
  assert_success
  assert_line "${REPO_ROOT}/lib/node/ai-tooling/session-inspect-cli.ts"
  assert_line '019f0109'
  assert_line '--user-dir=/tmp/sessions'
}

@test "ai-session-inspect: propagates CLI errors" {
  stub_command node <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'ai-session-inspect: no matching pi session found' >&2
exit 1
EOF
  run bash "${TOOL}" missing
  assert_failure
  assert_output --partial 'no matching pi session found'
}

@test "ai-session-inspect: completes flags and directories for --user-dir" {
  source "${REPO_ROOT}/dotenv/completion/ai-session-inspect.bash"
  COMP_WORDS=(ai-session-inspect --re)
  COMP_CWORD=1
  COMPREPLY=()
  _dot_ai_session_inspect
  assert_equal "${COMPREPLY[0]}" '--recaps'
  mkdir -p "${BATS_TEST_TMPDIR}/sessions-dir"
  COMP_WORDS=(ai-session-inspect --user-dir "${BATS_TEST_TMPDIR}/sessions-d")
  COMP_CWORD=2
  COMPREPLY=()
  _dot_ai_session_inspect
  assert_equal "${COMPREPLY[0]}" "${BATS_TEST_TMPDIR}/sessions-dir"
}
