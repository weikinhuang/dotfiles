#!/usr/bin/env bats
# Tests for dotenv/bin/ai-cost-doctor.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_isolated_home
  export XDG_CACHE_HOME="${BATS_TEST_TMPDIR}/cache"

  TOOL="${REPO_ROOT}/dotenv/bin/ai-cost-doctor"
  COPILOT_DIR="${HOME}/.copilot"
  COPILOT_DB="${COPILOT_DIR}/session-store.db"
  mkdir -p "${COPILOT_DIR}" "${XDG_CACHE_HOME}/ai-tool-usage"

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

  node --input-type=module - "${COPILOT_DB}" <<'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec(`CREATE TABLE sessions (
  id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT
);`);
db.exec(`CREATE TABLE assistant_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
  parent_tool_call_id TEXT, model TEXT, copilot_usage_model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, reasoning_tokens INTEGER, created_at TEXT
);`);
db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
  'aaaaaaaa-1111-2222-3333-444444444444',
  '2026-09-20T10:00:00.000Z',
  '2026-09-20T10:02:00.000Z',
);
const usage = db.prepare(`INSERT INTO assistant_usage_events
  (session_id, parent_tool_call_id, model, copilot_usage_model,
   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
   reasoning_tokens, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
usage.run('aaaaaaaa-1111-2222-3333-444444444444', null, 'gpt-5', null, 1000, 100, 800, 0, 20, '2026-09-20T10:00:00.000Z');
usage.run('aaaaaaaa-1111-2222-3333-444444444444', null, 'gpt-5', null, 1200, 80, 900, 0, 10, '2026-09-20T10:01:00.000Z');
usage.run('aaaaaaaa-1111-2222-3333-444444444444', 'spawn-1', 'gpt-5', null, 9999, 999, 0, 0, 0, '2026-09-20T10:01:30.000Z');
db.close();
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

@test "ai-cost-doctor: auto-detects a bare Copilot database path" {
  run "${TOOL}" "${COPILOT_DB}" --no-cost --json
  assert_success

  assert_equal "$(jq -r '.harness' <<<"${output}")" 'copilot'
  assert_equal "$(jq '.turns' <<<"${output}")" 2
  assert_equal "$(jq '.cost.total' <<<"${output}")" 0
}
