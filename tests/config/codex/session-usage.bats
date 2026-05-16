#!/usr/bin/env bats
# Tests for config/codex/session-usage.ts (invoked via dotenv/bin/ai-tool-usage).
# SPDX-License-Identifier: MIT
#
# Codex emits `token_count` events that carry cumulative `total_token_usage`,
# per-turn `last_token_usage`, and `model_context_window` inside an `info`
# block. Quota-ping `token_count` events arrive with `info: null` and must
# be skipped. These tests cover those edge cases.

setup() {
  load '../../helpers/common'
  setup_isolated_home
  export XDG_CACHE_HOME="${BATS_TEST_TMPDIR}/cache"

  SESSIONS_DIR="${HOME}/.codex/sessions/2026/05/01"
  mkdir -p "${SESSIONS_DIR}"
  TOOL="${REPO_ROOT}/dotenv/bin/ai-tool-usage"

  if ! command -v node >/dev/null 2>&1; then
    skip "node not installed"
  fi
  local node_major
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  if [[ "${node_major}" -lt 23 ]]; then
    skip "node ${node_major} lacks built-in TypeScript type stripping"
  fi

  # Codex costs use the LiteLLM pricing table; seed a deterministic cache so
  # the loader skips the network fetch. Rates don't matter for the context
  # assertions below - presence is enough.
  mkdir -p "${XDG_CACHE_HOME}/ai-tool-usage"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cat >"${XDG_CACHE_HOME}/ai-tool-usage/pricing.json" <<EOF
{"fetched_at":"${now}","data":{"gpt-5-codex":{"input_cost_per_token":1e-6,"output_cost_per_token":5e-6}}}
EOF
}

# Writes a rollout JSONL at $SESSIONS_DIR/rollout-<ts>-<sid>.jsonl from stdin.
write_session() {
  local sid="$1"
  local ts="${2:-2026-05-01T19-00-00}"
  cat >"${SESSIONS_DIR}/rollout-${ts}-${sid}.jsonl"
}

@test "codex: last_token_usage from final token_count event wins" {
  write_session "019dcodex-0000-0000-0000-000000000001" <<'EOF'
{"type":"session_meta","timestamp":"2026-05-01T19:00:00.000Z","payload":{"id":"019dcodex-0000-0000-0000-000000000001","cwd":"/proj","cli_version":"0.25.0"}}
{"type":"turn_context","timestamp":"2026-05-01T19:00:00.100Z","payload":{"model":"gpt-5-codex"}}
{"type":"event_msg","timestamp":"2026-05-01T19:00:01.000Z","payload":{"type":"user_message","message":"hi"}}
{"type":"event_msg","timestamp":"2026-05-01T19:00:02.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":500,"cached_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":10,"total_tokens":600},"last_token_usage":{"input_tokens":500,"cached_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":10,"total_tokens":600},"model_context_window":272000}}}
{"type":"event_msg","timestamp":"2026-05-01T19:00:03.000Z","payload":{"type":"user_message","message":"again"}}
{"type":"event_msg","timestamp":"2026-05-01T19:00:04.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1400,"cached_input_tokens":450,"output_tokens":180,"reasoning_output_tokens":25,"total_tokens":1580},"last_token_usage":{"input_tokens":900,"cached_input_tokens":450,"output_tokens":80,"reasoning_output_tokens":15,"total_tokens":980},"model_context_window":272000}}}
EOF

  run "${TOOL}" codex list --project /proj --json
  assert_success

  # Last token_count's last_token_usage.input_tokens = 900.
  assert_equal "$(jq '.sessions[0].last_context_tokens' <<<"${output}")" 900
  assert_equal "$(jq '.sessions[0].context_window' <<<"${output}")" 272000
}

@test "codex: token_count with null info does not clobber the last populated value" {
  # Quota-ping token_count events arrive as {type: token_count, info: null,
  # rate_limits: {...}}. They must be ignored entirely.
  write_session "019dcodex-0000-0000-0000-000000000002" "2026-05-01T19-10-00" <<'EOF'
{"type":"session_meta","timestamp":"2026-05-01T19:10:00.000Z","payload":{"id":"019dcodex-0000-0000-0000-000000000002","cwd":"/proj","cli_version":"0.25.0"}}
{"type":"turn_context","timestamp":"2026-05-01T19:10:00.100Z","payload":{"model":"gpt-5-codex"}}
{"type":"event_msg","timestamp":"2026-05-01T19:10:02.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":600,"cached_input_tokens":100,"output_tokens":40,"reasoning_output_tokens":5,"total_tokens":645},"last_token_usage":{"input_tokens":600,"cached_input_tokens":100,"output_tokens":40,"reasoning_output_tokens":5,"total_tokens":645},"model_context_window":272000}}}
{"type":"event_msg","timestamp":"2026-05-01T19:10:03.000Z","payload":{"type":"token_count","info":null,"rate_limits":{"plan_type":"business"}}}
{"type":"event_msg","timestamp":"2026-05-01T19:10:04.000Z","payload":{"type":"token_count","info":null,"rate_limits":{"plan_type":"business"}}}
EOF

  run "${TOOL}" codex list --project /proj --json
  assert_success

  # Null-info events must not reset or erase last_context_tokens.
  assert_equal "$(jq '.sessions[0].last_context_tokens' <<<"${output}")" 600
  assert_equal "$(jq '.sessions[0].context_window' <<<"${output}")" 272000
}
