#!/usr/bin/env bats
# Tests for dotenv/bin/ai-cost-doctor.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_isolated_home
  export XDG_CACHE_HOME="${BATS_TEST_TMPDIR}/cache"

  TOOL="${REPO_ROOT}/dotenv/bin/ai-cost-doctor"
  COPILOT_DIR="${HOME}/.copilot"
  COPILOT_EVENTS="${COPILOT_DIR}/session-state/aaaaaaaa-1111-2222-3333-444444444444/events.jsonl"
  mkdir -p "${COPILOT_EVENTS%/*}" "${XDG_CACHE_HOME}/ai-tool-usage"

  if ! command -v node >/dev/null 2>&1; then
    skip "node not installed"
  fi
  local node_major
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  if [[ "${node_major}" -lt 23 ]]; then
    skip "node ${node_major} lacks built-in TypeScript type stripping"
  fi

  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cat >"${XDG_CACHE_HOME}/ai-tool-usage/pricing.json" <<EOF
{"fetched_at":"${now}","data":{"gpt-5":{"input_cost_per_token":1e-5,"output_cost_per_token":5e-5,"cache_read_input_token_cost":2e-6}}}
EOF

  # inputTokens is the grand total (cached included); the spawn-1 call belongs
  # to a subagent and must stay out of the root series.
  node --input-type=module - "${COPILOT_EVENTS}" <<'EOF'
import { writeFileSync } from 'node:fs';
const usage = (ts, input, output, cacheRead, reasoning, parentToolCallId) => ({
  type: 'session.usage_record',
  data: {
    usage: {
      model: 'gpt-5', inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead,
      cacheWriteTokens: 0, reasoningTokens: reasoning, cost: 1,
      ...(parentToolCallId ? { parentToolCallId } : {}),
    },
  },
  id: `u-${ts}`, timestamp: ts, parentId: null,
});
const events = [
  {
    type: 'session.start',
    data: {
      sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', copilotVersion: '1.0.103',
      startTime: '2026-09-20T10:00:00.000Z', selectedModel: 'gpt-5', context: { cwd: '/proj' },
    },
    id: 's', timestamp: '2026-09-20T10:00:00.000Z', parentId: null,
  },
  { type: 'user.message', data: { content: 'hi' }, id: 'm', timestamp: '2026-09-20T10:00:00.000Z', parentId: null },
  usage('2026-09-20T10:00:00.000Z', 1000, 100, 800, 20),
  usage('2026-09-20T10:01:00.000Z', 1200, 80, 900, 10),
  usage('2026-09-20T10:01:30.000Z', 9999, 999, 0, 0, 'spawn-1'),
];
writeFileSync(process.argv[2], events.map((e) => JSON.stringify(e)).join('\n') + '\n');
EOF
}

@test "ai-cost-doctor: analyzes Copilot usage and excludes subagent rows" {
  run "${TOOL}" copilot aaaaaaaa --json --turns
  assert_success
  local report="${output}"

  assert_equal "$(jq -r '.harness' <<<"${report}")" 'copilot'
  assert_equal "$(jq -r '.sessionId' <<<"${report}")" 'aaaaaaaa-1111-2222-3333-444444444444'
  assert_equal "$(jq '.turns' <<<"${report}")" 2
  assert_equal "$(jq '.perTurn | length' <<<"${report}")" 2
  assert_equal "$(jq '.perTurn[0].tokens.output' <<<"${report}")" 120
  assert_equal "$(jq '.perTurn[0].tokens.cacheReadInput' <<<"${report}")" 800
  run jq -e '.cost.total > 0.01889 and .cost.total < 0.01891' <<<"${report}"
  assert_success
}

@test "ai-cost-doctor: auto-detects a bare Copilot events.jsonl path" {
  run "${TOOL}" "${COPILOT_EVENTS}" --no-cost --json
  assert_success

  assert_equal "$(jq -r '.harness' <<<"${output}")" 'copilot'
  assert_equal "$(jq '.turns' <<<"${output}")" 2
  assert_equal "$(jq '.cost.total' <<<"${output}")" 0
}
