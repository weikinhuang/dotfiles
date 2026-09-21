#!/usr/bin/env bats
# Tests for config/copilot/session-usage.ts (invoked via dotenv/bin/ai-tool-usage).
# SPDX-License-Identifier: MIT
#
# GitHub Copilot CLI stores session metadata, turns, usage events, and tool
# trajectory events in ~/.copilot/session-store.db. Tests seed the relevant
# schema with node's built-in sqlite module.

setup() {
  load '../../helpers/common'
  setup_isolated_home

  COPILOT_DIR="${HOME}/.copilot"
  COPILOT_DB="${COPILOT_DIR}/session-store.db"
  TOOL="${REPO_ROOT}/dotenv/bin/ai-tool-usage"
  mkdir -p "${COPILOT_DIR}"

  if ! command -v node >/dev/null 2>&1; then
    skip "node not installed"
  fi
  local node_major
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  if [[ "${node_major}" -lt 23 ]]; then
    skip "node ${node_major} lacks built-in TypeScript type stripping"
  fi

  node --input-type=module - "${COPILOT_DB}" <<'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec(`CREATE TABLE sessions (
  id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT,
  summary TEXT, created_at TEXT, updated_at TEXT
);`);
db.exec(`CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER,
  user_message TEXT, assistant_response TEXT, timestamp TEXT
);`);
db.exec(`CREATE TABLE assistant_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER,
  agent_id TEXT, parent_tool_call_id TEXT, model TEXT, copilot_usage_model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_nano_aiu INTEGER,
  request_multiplier REAL, duration_ms INTEGER, time_to_first_token_ms INTEGER,
  output_ttft_ms REAL, inter_token_latency_ms INTEGER, initiator TEXT,
  api_endpoint TEXT, reasoning_effort TEXT, finish_reason TEXT,
  content_filter_triggered INTEGER, token_details_json TEXT, created_at TEXT
);`);
db.exec(`CREATE TABLE forge_trajectory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, tool_call_id TEXT,
  turn_index INTEGER, event_type TEXT, command TEXT, output TEXT,
  exit_code INTEGER, event_key TEXT, event_value TEXT, created_at TEXT
);`);
db.close();
EOF
}

seed_primary_session() {
  node --input-type=module - "${COPILOT_DB}" <<'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
  'aaaaaaaa-1111-2222-3333-444444444444', '/proj', null, 'cli', 'main',
  'Fix authentication', '2026-09-20T10:00:00.000Z', '2026-09-20T10:05:00.000Z',
);
const turn = db.prepare('INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)');
turn.run('aaaaaaaa-1111-2222-3333-444444444444', 0, 'fix auth\nand add tests', 'Working on it', '2026-09-20T10:00:00.000Z');
turn.run('aaaaaaaa-1111-2222-3333-444444444444', 1, 'continue', 'Done', '2026-09-20T10:05:00.000Z');
const usage = db.prepare(`INSERT INTO assistant_usage_events
  (session_id, turn_index, agent_id, parent_tool_call_id, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
usage.run('aaaaaaaa-1111-2222-3333-444444444444', 0, 'copilot', null, 'gpt-5', 100, 10, 900, 20, 5, '2026-09-20T10:01:00.000Z');
usage.run('aaaaaaaa-1111-2222-3333-444444444444', 1, 'copilot', null, 'claude-sonnet-4.5', 200, 50, 300, 20, 7, '2026-09-20T10:04:00.000Z');
usage.run('aaaaaaaa-1111-2222-3333-444444444444', 1, 'agent-1', 'spawn-1', 'gpt-4.1', 40, 15, 60, 0, 2, '2026-09-20T10:03:00.000Z');
usage.run('aaaaaaaa-1111-2222-3333-444444444444', 1, 'agent-1', 'spawn-1', 'gpt-4.1', 10, 5, 20, 0, 1, '2026-09-20T10:03:30.000Z');
const event = db.prepare(`INSERT INTO forge_trajectory_events
  (session_id, tool_call_id, turn_index, event_type, command, event_key, event_value, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
event.run('aaaaaaaa-1111-2222-3333-444444444444', 'tool-1', 0, 'tool_start', 'git status', null, null, '2026-09-20T10:01:00.000Z');
event.run('aaaaaaaa-1111-2222-3333-444444444444', 'tool-1', 0, 'tool_finish', 'git status', null, null, '2026-09-20T10:01:01.000Z');
event.run('aaaaaaaa-1111-2222-3333-444444444444', 'tool-2', 1, 'metadata', null, 'tool_name', 'view', '2026-09-20T10:03:00.000Z');
db.close();
EOF
}

@test "copilot: list reports root usage, context, tools, and preview" {
  seed_primary_session

  run "${TOOL}" copilot list --project /proj --json
  assert_success

  assert_equal "$(jq '.sessions | length' <<<"${output}")" 1
  assert_equal "$(jq -r '.sessions[0].model' <<<"${output}")" 'claude-sonnet-4.5'
  assert_equal "$(jq '.sessions[0].tokens.input' <<<"${output}")" 300
  assert_equal "$(jq '.sessions[0].tokens.output' <<<"${output}")" 60
  assert_equal "$(jq '.sessions[0].tokens.cache_read' <<<"${output}")" 1200
  assert_equal "$(jq '.sessions[0].tokens.cache_write' <<<"${output}")" 40
  assert_equal "$(jq '.sessions[0].tokens.reasoning' <<<"${output}")" 12
  assert_equal "$(jq '.sessions[0].last_context_tokens' <<<"${output}")" 520
  assert_equal "$(jq '.sessions[0].tool_calls' <<<"${output}")" 2
  assert_equal "$(jq '.sessions[0].tool_breakdown.shell' <<<"${output}")" 1
  assert_equal "$(jq '.sessions[0].tool_breakdown.view' <<<"${output}")" 1
  assert_equal "$(jq '.sessions[0].subagent_count' <<<"${output}")" 1
  assert_equal "$(jq -r '.sessions[0].preview' <<<"${output}")" 'fix auth and add tests'
}

@test "copilot: session detail reports subagent usage separately" {
  seed_primary_session

  run "${TOOL}" copilot session aaaaaaaa --json
  assert_success

  assert_equal "$(jq '.subagents | length' <<<"${output}")" 1
  assert_equal "$(jq -r '.subagents[0].agent_id' <<<"${output}")" 'spawn-1'
  assert_equal "$(jq -r '.subagents[0].agent_label' <<<"${output}")" 'agent-1'
  assert_equal "$(jq -r '.subagents[0].model' <<<"${output}")" 'gpt-4.1'
  assert_equal "$(jq '.subagents[0].tokens.input' <<<"${output}")" 50
  assert_equal "$(jq '.subagents[0].tokens.output' <<<"${output}")" 20
}

@test "copilot: totals include sessions across projects" {
  seed_primary_session
  node --input-type=module - "${COPILOT_DB}" <<'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
  'bbbbbbbb-1111-2222-3333-444444444444', '/other', null, 'cli', 'main',
  null, '2026-09-21T10:00:00.000Z', '2026-09-21T10:01:00.000Z',
);
db.prepare(`INSERT INTO assistant_usage_events
  (session_id, turn_index, agent_id, parent_tool_call_id, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'bbbbbbbb-1111-2222-3333-444444444444', 0, 'copilot', null, 'gpt-5',
    50, 25, 100, 0, 0, '2026-09-21T10:00:30.000Z',
  );
db.close();
EOF

  run "${TOOL}" copilot totals --json
  assert_success

  assert_equal "$(jq '.session_count' <<<"${output}")" 2
  assert_equal "$(jq '.totals.tokens.input' <<<"${output}")" 350
  assert_equal "$(jq '.totals.tokens.output' <<<"${output}")" 85
  assert_equal "$(jq '.totals.subagents' <<<"${output}")" 1
  assert_equal "$(jq '.totals.cost' <<<"${output}")" 0
}
