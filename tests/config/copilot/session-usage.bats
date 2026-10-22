#!/usr/bin/env bats
# Tests for config/copilot/session-usage.ts (invoked via dotenv/bin/ai-tool-usage).
# SPDX-License-Identifier: MIT
#
# GitHub Copilot CLI writes one directory per session under
# $COPILOT_HOME/session-state/<uuid>/ with an events.jsonl event log and a
# workspace.yaml. Tests seed those files directly.

setup() {
  load '../../helpers/common'
  setup_isolated_home
  unset COPILOT_HOME

  COPILOT_DIR="${HOME}/.copilot"
  STATE_DIR="${COPILOT_DIR}/session-state"
  TOOL="${REPO_ROOT}/dotenv/bin/ai-tool-usage"
  mkdir -p "${STATE_DIR}"

  if ! command -v node >/dev/null 2>&1; then
    skip "node not installed"
  fi
  local node_major
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  if [[ "${node_major}" -lt 23 ]]; then
    skip "node ${node_major} lacks built-in TypeScript type stripping"
  fi
}

# Writes session.start for <state-dir>/<id> with the given cwd and start time.
# Args: <state-dir> <session-id> <cwd> <start-time> [copilot-version]
start_session() {
  local state_dir="$1" sid="$2" cwd="$3" start="$4" version="${5:-1.0.103}"
  mkdir -p "${state_dir}/${sid}"
  printf '{"type":"session.start","data":{"sessionId":"%s","version":1,"producer":"copilot-agent","copilotVersion":"%s","startTime":"%s","selectedModel":"gpt-5","context":{"cwd":"%s"}},"id":"e0","timestamp":"%s","parentId":null}\n' \
    "${sid}" "${version}" "${start}" "${cwd}" "${start}" >"${state_dir}/${sid}/events.jsonl"
}

# Appends raw event lines (one per argument) to <state-dir>/<id>/events.jsonl.
add_events() {
  local file="$1/$2/events.jsonl"
  shift 2
  printf '%s\n' "$@" >>"${file}"
}

# session.usage_record line. Args: <timestamp> <model> <input> <output>
# <cache-read> <cache-write> <reasoning> [parent-tool-call-id]
usage_record() {
  local ts="$1" model="$2" input="$3" output="$4" read="$5" write="$6" reasoning="$7" parent="${8:-}"
  local extra="" agent=""
  if [[ -n "${parent}" ]]; then
    extra=",\"parentToolCallId\":\"${parent}\",\"initiator\":\"sub-agent\""
    agent=",\"agentId\":\"agent-${parent}\""
  fi
  printf '{"type":"session.usage_record","data":{"usage":{"model":"%s","inputTokens":%s,"outputTokens":%s,"cacheReadTokens":%s,"cacheWriteTokens":%s,"reasoningTokens":%s,"cost":1%s}},"id":"u-%s","timestamp":"%s","parentId":null%s}' \
    "${model}" "${input}" "${output}" "${read}" "${write}" "${reasoning}" "${extra}" "${ts}" "${ts}" "${agent}"
}

# tool.execution_start line. Args: <timestamp> <tool-call-id> <tool-name> [parent-tool-call-id]
tool_start() {
  local ts="$1" id="$2" name="$3" parent="${4:-}"
  local extra=""
  [[ -n "${parent}" ]] && extra=",\"parentToolCallId\":\"${parent}\""
  printf '{"type":"tool.execution_start","data":{"toolCallId":"%s","toolName":"%s"%s},"id":"t-%s","timestamp":"%s","parentId":null}' \
    "${id}" "${name}" "${extra}" "${id}" "${ts}"
}

user_message() {
  printf '{"type":"user.message","data":{"content":"%s"},"id":"m-%s","timestamp":"%s","parentId":null}' "$2" "$1" "$1"
}

seed_primary_session() {
  local sid="aaaaaaaa-1111-2222-3333-444444444444"
  start_session "${STATE_DIR}" "${sid}" /proj 2026-09-20T10:00:00.000Z
  printf 'id: %s\nname: Fix authentication\nsummary_count: 0\n' "${sid}" >"${STATE_DIR}/${sid}/workspace.yaml"
  add_events "${STATE_DIR}" "${sid}" \
    "$(user_message 2026-09-20T10:00:01.000Z 'fix auth\nand add tests')" \
    "$(usage_record 2026-09-20T10:01:00.000Z gpt-5 1020 10 900 20 5)" \
    "$(tool_start 2026-09-20T10:01:01.000Z tool-1 bash)" \
    "$(tool_start 2026-09-20T10:01:02.000Z tool-1 bash)" \
    "$(tool_start 2026-09-20T10:02:00.000Z spawn-1 task)" \
    '{"type":"subagent.started","data":{"toolCallId":"spawn-1","agentName":"explore","agentDisplayName":"Explore","agentDescription":"find auth code"},"id":"s1","timestamp":"2026-09-20T10:02:01.000Z","parentId":null}' \
    "$(usage_record 2026-09-20T10:03:00.000Z gpt-4.1 100 15 60 0 2 spawn-1)" \
    "$(usage_record 2026-09-20T10:03:30.000Z gpt-4.1 30 5 20 0 1 spawn-1)" \
    "$(tool_start 2026-09-20T10:03:10.000Z sub-tool-1 grep spawn-1)" \
    "$(user_message 2026-09-20T10:04:00.000Z continue)" \
    "$(tool_start 2026-09-20T10:04:10.000Z tool-2 view)" \
    'not json' \
    "$(usage_record 2026-09-20T10:05:00.000Z claude-sonnet-4.5 520 50 300 20 7)" \
    '{"type":"session.shutdown","data":{"shutdownType":"routine","modelMetrics":{}},"id":"x","timestamp":"2026-09-21T09:00:00.000Z","parentId":null}'
}

@test "copilot: list reports root usage, context, tools, title, and duration" {
  seed_primary_session

  run "${TOOL}" copilot list --project /proj --json
  assert_success

  assert_equal "$(jq '.sessions | length' <<<"${output}")" 1
  assert_equal "$(jq -r '.sessions[0].model' <<<"${output}")" 'claude-sonnet-4.5'
  assert_equal "$(jq '.sessions[0].tokens.input' <<<"${output}")" 1540
  assert_equal "$(jq '.sessions[0].tokens.output' <<<"${output}")" 60
  assert_equal "$(jq '.sessions[0].tokens.cache_read' <<<"${output}")" 1200
  assert_equal "$(jq '.sessions[0].tokens.cache_write' <<<"${output}")" 40
  assert_equal "$(jq '.sessions[0].tokens.reasoning' <<<"${output}")" 12
  # inputTokens already includes cache read + cache write.
  assert_equal "$(jq '.sessions[0].last_context_tokens' <<<"${output}")" 520
  assert_equal "$(jq '.sessions[0].user_turns' <<<"${output}")" 2
  assert_equal "$(jq '.sessions[0].tool_calls' <<<"${output}")" 3
  assert_equal "$(jq -c '.sessions[0].tool_breakdown' <<<"${output}")" '{"bash":1,"task":1,"view":1}'
  assert_equal "$(jq '.sessions[0].subagent_count' <<<"${output}")" 1
  assert_equal "$(jq -r '.sessions[0].title' <<<"${output}")" 'Fix authentication'
  assert_equal "$(jq -r '.sessions[0].preview' <<<"${output}")" 'fix auth and add tests'
  # Start to last activity; the late session.shutdown is ignored.
  assert_equal "$(jq '.sessions[0].duration_seconds' <<<"${output}")" 300
}

@test "copilot: session detail reports subagent usage separately" {
  seed_primary_session

  run "${TOOL}" copilot session aaaaaaaa --json
  assert_success

  assert_equal "$(jq '.subagents | length' <<<"${output}")" 1
  assert_equal "$(jq -r '.subagents[0].agent_id' <<<"${output}")" 'spawn-1'
  assert_equal "$(jq -r '.subagents[0].agent_label' <<<"${output}")" 'explore'
  assert_equal "$(jq -r '.subagents[0].model' <<<"${output}")" 'gpt-4.1'
  assert_equal "$(jq '.subagents[0].tokens.input' <<<"${output}")" 130
  assert_equal "$(jq '.subagents[0].tokens.output' <<<"${output}")" 20
  assert_equal "$(jq '.subagents[0].tool_calls' <<<"${output}")" 1
}

@test "copilot: session prefix must be unique" {
  seed_primary_session
  start_session "${STATE_DIR}" aaaaaaaa-9999-2222-3333-444444444444 /proj 2026-09-21T10:00:00.000Z

  run "${TOOL}" copilot session aaaaaaaa
  assert_failure
  assert_output --partial 'Ambiguous session prefix "aaaaaaaa"'
  assert_output --partial 'aaaaaaaa-1111-2222-3333-444444444444'
  assert_output --partial 'aaaaaaaa-9999-2222-3333-444444444444'

  run "${TOOL}" copilot session aaaaaaaa-1111 --json
  assert_success
  assert_equal "$(jq -r '.session_id' <<<"${output}")" 'aaaaaaaa-1111-2222-3333-444444444444'
}

@test "copilot: totals include sessions across projects" {
  seed_primary_session
  start_session "${STATE_DIR}" bbbbbbbb-1111-2222-3333-444444444444 /other 2026-09-21T10:00:00.000Z
  add_events "${STATE_DIR}" bbbbbbbb-1111-2222-3333-444444444444 \
    "$(user_message 2026-09-21T10:00:10.000Z hi)" \
    "$(usage_record 2026-09-21T10:00:30.000Z gpt-5 150 25 100 0 0)"

  run "${TOOL}" copilot totals --json
  assert_success

  assert_equal "$(jq '.session_count' <<<"${output}")" 2
  assert_equal "$(jq '.totals.tokens.input' <<<"${output}")" 1690
  assert_equal "$(jq '.totals.tokens.output' <<<"${output}")" 85
  assert_equal "$(jq '.totals.subagents' <<<"${output}")" 1
  assert_equal "$(jq '.totals.cost' <<<"${output}")" 0
}

@test "copilot: --project / matches every session" {
  seed_primary_session
  start_session "${STATE_DIR}" bbbbbbbb-1111-2222-3333-444444444444 /other 2026-09-21T10:00:00.000Z
  add_events "${STATE_DIR}" bbbbbbbb-1111-2222-3333-444444444444 "$(user_message 2026-09-21T10:00:10.000Z hi)"

  run "${TOOL}" copilot list --project / --json
  assert_success
  assert_equal "$(jq '.sessions | length' <<<"${output}")" 2

  run "${TOOL}" copilot list --project /pro --json
  assert_success
  assert_equal "$(jq '.sessions | length' <<<"${output}")" 0
}

@test "copilot: never-prompted sessions are skipped silently" {
  seed_primary_session
  mkdir -p "${STATE_DIR}/cccccccc-1111-2222-3333-444444444444"
  printf 'id: cccccccc\n' >"${STATE_DIR}/cccccccc-1111-2222-3333-444444444444/workspace.yaml"

  run bash -c "'${TOOL}' copilot list --project /proj --json 2>&1"
  assert_success
  assert_equal "$(jq '.sessions | length' <<<"${output}")" 1
}

@test "copilot: pre-usage_record sessions are skipped by list and rejected by session" {
  seed_primary_session
  local sid="dddddddd-1111-2222-3333-444444444444"
  start_session "${STATE_DIR}" "${sid}" /proj 2026-09-19T10:00:00.000Z 1.0.89
  add_events "${STATE_DIR}" "${sid}" \
    "$(user_message 2026-09-19T10:00:01.000Z old)" \
    '{"type":"model.model_call_success","data":{"modelCall":{"model":"gpt-5"}},"id":"m","timestamp":"2026-09-19T10:00:02.000Z","parentId":null}'

  run bash -c "'${TOOL}' copilot list --project /proj --json 2>'${BATS_TEST_TMPDIR}/stderr'"
  assert_success
  assert_equal "$(jq '.sessions | length' <<<"${output}")" 1
  run cat "${BATS_TEST_TMPDIR}/stderr"
  assert_output 'skipped 1 session(s) recorded in an unsupported older event format'

  run "${TOOL}" copilot session dddddddd
  assert_failure
  assert_output --partial "session ${sid} was recorded by copilot 1.0.89"
  assert_output --partial 'pre-usage_record event format, which is not supported'
}

@test "copilot: missing session-state directory fails with a clear error" {
  rm -rf "${STATE_DIR}"

  run "${TOOL}" copilot list
  assert_failure
  assert_output --partial "GitHub Copilot session-state directory not found: ${STATE_DIR}"
}

@test "copilot: COPILOT_HOME is the default user dir and --user-dir wins" {
  local profile="${BATS_TEST_TMPDIR}/profile"
  start_session "${profile}/session-state" eeeeeeee-1111-2222-3333-444444444444 /proj 2026-09-22T10:00:00.000Z
  add_events "${profile}/session-state" eeeeeeee-1111-2222-3333-444444444444 "$(user_message 2026-09-22T10:00:01.000Z hi)"
  seed_primary_session

  run bash -c "COPILOT_HOME='${profile}' '${TOOL}' copilot list --project /proj --json"
  assert_success
  assert_equal "$(jq -r '.sessions[0].session_id' <<<"${output}")" 'eeeeeeee-1111-2222-3333-444444444444'

  run bash -c "COPILOT_HOME='${profile}' '${TOOL}' copilot list --user-dir '${COPILOT_DIR}' --project /proj --json"
  assert_success
  assert_equal "$(jq -r '.sessions[0].session_id' <<<"${output}")" 'aaaaaaaa-1111-2222-3333-444444444444'
}
