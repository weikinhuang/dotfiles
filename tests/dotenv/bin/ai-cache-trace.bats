#!/usr/bin/env bats
# SPDX-License-Identifier: MIT
setup() {
  load '../../helpers/common'
  setup_test_bin
  TOOL="${REPO_ROOT}/dotenv/bin/ai-cache-trace"
}

@test "ai-cache-trace: help is local and lists logging inspection options" {
  for flag in -h --help; do
    run bash "${TOOL}" "${flag}"
    assert_success
    assert_output --partial 'Usage: ai-cache-trace'
    assert_output --partial '--show-system'
  done
}

@test "ai-cache-trace: delegates arguments unchanged to the local node parser" {
  stub_command node <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
  run bash "${TOOL}" 'trace file.jsonl' --from=1 --to 2 --json
  assert_success
  assert_line "${REPO_ROOT}/lib/node/ai-tooling/cache-trace-cli.ts"
  assert_line 'trace file.jsonl'
  assert_line '--from=1'
}

@test "ai-cache-trace: propagates parser errors without invoking a provider" {
  stub_command node <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'ai-cache-trace: unknown argument: --bad' >&2
exit 1
EOF
  run bash "${TOOL}" --bad
  assert_failure
  assert_output --partial 'unknown argument'
}

@test "ai-cache-trace: completes flags without suggesting files for numeric values" {
  source "${REPO_ROOT}/dotenv/completion/ai-cache-trace.bash"
  COMP_WORDS=(ai-cache-trace --sh)
  COMP_CWORD=1
  COMPREPLY=()
  _dot_ai_cache_trace
  assert_equal "${COMPREPLY[0]}" '--show-system'
  COMP_WORDS=(ai-cache-trace --from '')
  COMP_CWORD=2
  COMPREPLY=()
  _dot_ai_cache_trace
  assert_equal "${#COMPREPLY[@]}" 0
}
