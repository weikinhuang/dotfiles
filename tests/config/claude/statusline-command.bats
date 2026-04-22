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
  [[ "${output}" == *']8;;https://claude.ai/settings/usage'* ]]
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

@test "statusline-command: wraps cwd with OSC 8 hyperlink" {
  create_statusline_repo
  write_statusline_payload "${TEST_REPO}"

  run env SCRIPT="${SCRIPT}" PAYLOAD="${PAYLOAD}" bash -c 'bash "${SCRIPT}" < "${PAYLOAD}"'
  assert_success

  local osc8_open=$'\e]8;;file://'"${TEST_REPO}"$'\e\\'
  [[ "${output}" == *"${osc8_open}"* ]]
  [[ "${output}" == *$'\e]8;;\e\\'* ]]
}

@test "statusline-command: suppresses cwd hyperlink when DOT_DISABLE_HYPERLINKS is set" {
  create_statusline_repo
  write_statusline_payload "${TEST_REPO}"

  run env DOT_DISABLE_HYPERLINKS=1 SCRIPT="${SCRIPT}" PAYLOAD="${PAYLOAD}" bash -c 'bash "${SCRIPT}" < "${PAYLOAD}"'
  assert_success

  [[ "${output}" != *']8;;file://'* ]]
}

@test "statusline-command: uses wsl.localhost prefix on WSL" {
  create_statusline_repo
  write_statusline_payload "${TEST_REPO}"

  run env WSL_DISTRO_NAME="TestDistro" SCRIPT="${SCRIPT}" PAYLOAD="${PAYLOAD}" bash -c 'bash "${SCRIPT}" < "${PAYLOAD}"'
  assert_success

  [[ "${output}" == *'wsl.localhost/TestDistro'* ]]
}

@test "statusline-command: uses native Windows URL for WSL /mnt/ paths" {
  PAYLOAD="${BATS_TEST_TMPDIR}/payload.json"
  cat >"${PAYLOAD}" <<'EOF'
{
  "cwd": "/mnt/d/projects/test",
  "model": { "display_name": "Opus" },
  "session": {
    "remaining_tokens": 50000,
    "total_input_tokens": 10000,
    "total_output_tokens": 2000,
    "cost_usd": 0.42
  }
}
EOF

  run env WSL_DISTRO_NAME="TestDistro" SCRIPT="${SCRIPT}" PAYLOAD="${PAYLOAD}" bash -c 'bash "${SCRIPT}" < "${PAYLOAD}"'
  assert_success

  [[ "${output}" == *'file:///D:/projects/test'* ]]
  [[ "${output}" != *'wsl.localhost'* ]]
}

write_subagent_transcripts() {
  local subagent_dir="$1"
  mkdir -p "${subagent_dir}"

  # Tool result contents sum to 100+200+400 = 700 bytes → ~175 tokens with /4 estimate.
  local pad100 pad200 pad400
  printf -v pad100 '%.0s.' {1..100}
  printf -v pad200 '%.0s.' {1..200}
  printf -v pad400 '%.0s.' {1..400}

  cat >"${subagent_dir}/agent-aaa.jsonl" <<EOF
{"type":"user","message":{"role":"user","content":"hi"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read"},{"type":"text","text":"ok"}],"usage":{"input_tokens":100,"cache_creation_input_tokens":3000,"cache_read_input_tokens":50,"output_tokens":25}}}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"${pad100}"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash"},{"type":"tool_use","id":"t3","name":"Read"}],"usage":{"input_tokens":200,"cache_creation_input_tokens":0,"cache_read_input_tokens":1500,"output_tokens":75}}}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t2","type":"tool_result","content":"${pad200}"}]}}
EOF

  cat >"${subagent_dir}/agent-bbb.jsonl" <<EOF
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t4","name":"Grep"}],"usage":{"input_tokens":700,"cache_creation_input_tokens":5000,"cache_read_input_tokens":450,"output_tokens":900}}}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t4","type":"tool_result","content":"${pad400}"}]}}
EOF

  # Sibling meta file that must be ignored by the glob.
  echo '{"agentType":"x"}' >"${subagent_dir}/agent-aaa.meta.json"
}

write_statusline_payload_with_transcript() {
  local cwd="$1"
  local transcript_path="$2"
  PAYLOAD="${BATS_TEST_TMPDIR}/payload.json"

  cat >"${PAYLOAD}" <<EOF
{
  "cwd": "${cwd}",
  "model": { "display_name": "Opus" },
  "workspace": { "current_dir": "${cwd}" },
  "transcript_path": "${transcript_path}",
  "cost": { "total_cost_usd": 0.01234 },
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

write_statusline_payload_with_worktree() {
  local cwd="$1"
  local worktree_name="$2"
  PAYLOAD="${BATS_TEST_TMPDIR}/payload.json"

  cat >"${PAYLOAD}" <<EOF
{
  "cwd": "${cwd}",
  "model": { "display_name": "Opus" },
  "workspace": {
    "current_dir": "${cwd}",
    "git_worktree": "${worktree_name}"
  }
}
EOF
}

@test "statusline-command: shows worktree marker when workspace.git_worktree is set" {
  create_statusline_repo
  write_statusline_payload_with_worktree "${TEST_REPO}" "feat-statusline"

  run env SCRIPT="${SCRIPT}" PAYLOAD="${PAYLOAD}" bash -c 'bash "${SCRIPT}" < "${PAYLOAD}"'
  assert_success
  assert_output --partial "⎇ feat-statusline"
}

@test "statusline-command: omits worktree marker when workspace.git_worktree is absent" {
  create_statusline_repo
  write_statusline_payload "${TEST_REPO}"

  run env SCRIPT="${SCRIPT}" PAYLOAD="${PAYLOAD}" bash -c 'bash "${SCRIPT}" < "${PAYLOAD}"'
  assert_success
  [[ "${output}" != *"⎇"* ]]
}

@test "statusline-command: emits cumulative subagent tokens from subagents directory" {
  create_statusline_repo
  local transcript_path="${BATS_TEST_TMPDIR}/session.jsonl"
  : >"${transcript_path}"
  write_subagent_transcripts "${BATS_TEST_TMPDIR}/session/subagents"
  write_statusline_payload_with_transcript "${TEST_REPO}" "${transcript_path}"

  run env SCRIPT="${SCRIPT}" PAYLOAD="${PAYLOAD}" bash -c 'bash "${SCRIPT}" < "${PAYLOAD}"'
  assert_success
  # 2 subagent files; input (incl. cache_creation): (100+3000)+(200+0)+(700+5000)=9000 (9k)
  # cache_read: 50+1500+450=2000 (2k); output: 25+75+900=1000 (1k)
  # tool_use blocks: 1+2+1=4 in subagents.
  # tool_result bytes: 100+200+400=700; /4 ≈ 175 tokens.
  assert_output --partial "A(2):↑9k/↻ 2k/↓1k"
  assert_output --partial "⚒ A:4(~175)"
}

@test "statusline-command: derives session totals (incl. cache read) from the main transcript" {
  create_statusline_repo
  local transcript_path="${BATS_TEST_TMPDIR}/session.jsonl"
  local tr_pad_a tr_pad_b
  # Tool result bytes: 800 → ~200 tokens with /4 estimate.
  printf -v tr_pad_a '%.0s.' {1..500}
  printf -v tr_pad_b '%.0s.' {1..300}

  cat >"${transcript_path}" <<EOF
{"type":"user","message":{"role":"user","content":"hi"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"s1","name":"Read"},{"type":"tool_use","id":"s2","name":"Read"}],"usage":{"input_tokens":50,"cache_creation_input_tokens":2000,"cache_read_input_tokens":10000,"output_tokens":500}}}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"s1","type":"tool_result","content":"${tr_pad_a}"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"s3","name":"Bash"}],"usage":{"input_tokens":150,"cache_creation_input_tokens":0,"cache_read_input_tokens":25000,"output_tokens":1500}}}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"s3","type":"tool_result","content":[{"type":"text","text":"${tr_pad_b}"}]}]}}
EOF
  write_statusline_payload_with_transcript "${TEST_REPO}" "${transcript_path}"

  run env SCRIPT="${SCRIPT}" PAYLOAD="${PAYLOAD}" bash -c 'bash "${SCRIPT}" < "${PAYLOAD}"'
  assert_success
  # input (incl. cache_creation): (50+2000)+(150+0)=2200 (2k)
  # cache_read: 10000+25000=35000 (35k); output: 500+1500=2000 (2k)
  # tool_use blocks: 2+1=3 in main session.
  # tool_result bytes: 500+300=800; /4 = 200 tokens. The second result is an array-of-text block to
  # verify both string and nested-array content shapes are counted.
  assert_output --partial "S:2k↑/35k↻/2k↓"
  assert_output --partial "⚒ S:3(~200)"
  # Fallback JSON totals must NOT appear when transcript-derived totals are emitted.
  [[ "${output}" != *"15.23M"* ]]
}

@test "statusline-command: falls back to JSON session totals when transcript is absent" {
  create_statusline_repo
  write_statusline_payload "${TEST_REPO}"

  run env SCRIPT="${SCRIPT}" PAYLOAD="${PAYLOAD}" bash -c 'bash "${SCRIPT}" < "${PAYLOAD}"'
  assert_success
  assert_output --partial "S:15.23M↑/4k↓"
  [[ "${output}" != *"↻/"* ]]
}

@test "statusline-command: omits subagent segment when no subagent transcripts exist" {
  create_statusline_repo
  local transcript_path="${BATS_TEST_TMPDIR}/session.jsonl"
  : >"${transcript_path}"
  write_statusline_payload_with_transcript "${TEST_REPO}" "${transcript_path}"

  run env SCRIPT="${SCRIPT}" PAYLOAD="${PAYLOAD}" bash -c 'bash "${SCRIPT}" < "${PAYLOAD}"'
  assert_success
  [[ "${output}" != *"A("* ]]
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
