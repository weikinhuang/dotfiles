#!/usr/bin/env bats
# Tests for config/claude/session-usage.ts (invoked via dotenv/bin/ai-tool-usage).
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_isolated_home
  export XDG_CACHE_HOME="${BATS_TEST_TMPDIR}/cache"

  PROJECTS_DIR="${HOME}/.claude/projects"
  mkdir -p "${PROJECTS_DIR}"
  TOOL="${REPO_ROOT}/dotenv/bin/ai-tool-usage"

  if ! command -v node >/dev/null 2>&1; then
    skip "node not installed"
  fi
  local node_major
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  if [[ "${node_major}" -lt 23 ]]; then
    skip "node ${node_major} lacks built-in TypeScript type stripping"
  fi

  seed_pricing_cache
}

# Writes a pricing cache with a freshly-stamped fetched_at so the loader
# treats it as fresh and skips the network fetch. Two fake models with
# round per-token rates make cost assertions easy to verify by hand.
seed_pricing_cache() {
  mkdir -p "${XDG_CACHE_HOME}/ai-tool-usage"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cat >"${XDG_CACHE_HOME}/ai-tool-usage/pricing.json" <<EOF
{"fetched_at":"${now}","data":{"test-opus":{"input_cost_per_token":1e-5,"output_cost_per_token":5e-5,"cache_read_input_token_cost":1e-6,"cache_creation_input_token_cost":1.25e-5},"test-sonnet":{"input_cost_per_token":3e-6,"output_cost_per_token":1.5e-5,"cache_read_input_token_cost":3e-7,"cache_creation_input_token_cost":3.75e-6}}}
EOF
}

# Writes a JSONL session file at $PROJECTS_DIR/<slug>/<sid>.jsonl from stdin.
write_session() {
  local slug="$1"
  local sid="$2"
  local proj="${PROJECTS_DIR}/${slug}"
  mkdir -p "${proj}"
  cat >"${proj}/${sid}.jsonl"
}

# Asserts that two floating-point strings are within tolerance.
assert_float_near() {
  local actual="$1"
  local expected="$2"
  local tol="${3:-0.0001}"
  if ! awk -v a="${actual}" -v e="${expected}" -v t="${tol}" \
    'BEGIN { d = a - e; if (d < 0) d = -d; exit (d > t) }'; then
    batslib_print_kv_single_or_multi 8 \
      'actual' "${actual}" \
      'expected' "${expected}" \
      'tolerance' "${tol}" \
      | batslib_decorate "values differ beyond tolerance" \
      | fail
  fi
}

@test "claude: assistant entries sharing message.id count usage once" {
  # Claude Code writes one assistant response as multiple JSONL lines, each
  # repeating the full `usage` object. Without dedup the totals double/triple.
  write_session "-proj" "s1" <<'EOF'
{"type":"assistant","timestamp":"2026-04-23T10:00:00Z","message":{"id":"m1","model":"test-opus","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500},"content":[{"type":"text","text":"thinking"}]}}
{"type":"assistant","timestamp":"2026-04-23T10:00:01Z","message":{"id":"m1","model":"test-opus","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500},"content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{}}]}}
{"type":"assistant","timestamp":"2026-04-23T10:00:02Z","message":{"id":"m1","model":"test-opus","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500},"content":[{"type":"tool_use","id":"tu_2","name":"Bash","input":{}}]}}
{"type":"assistant","timestamp":"2026-04-23T10:00:03Z","message":{"id":"m2","model":"test-opus","usage":{"input_tokens":20,"output_tokens":10,"cache_read_input_tokens":500,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"done"}]}}
EOF

  run "${TOOL}" claude list --project -proj --json
  assert_success

  assert_equal "$(jq '.totals.tokens.input' <<<"${output}")" 120
  assert_equal "$(jq '.totals.tokens.output' <<<"${output}")" 60
  assert_equal "$(jq '.totals.tokens.cache_read' <<<"${output}")" 1500
  assert_equal "$(jq '.totals.tokens.cache_write' <<<"${output}")" 500
  # Tool calls are counted across every slice (each entry's tool_use blocks
  # are distinct partial chunks of the full response).
  assert_equal "$(jq '.totals.tool_calls' <<<"${output}")" 2
  # Last-turn context = m2's input + cache_read + cache_write = 20 + 500 + 0.
  # Must NOT be m1's dedup-inflated value.
  assert_equal "$(jq '.sessions[0].last_context_tokens' <<<"${output}")" 520
}

@test "claude: mixed-model session prices each slice at its own rate" {
  write_session "-proj" "s1" <<'EOF'
{"type":"assistant","timestamp":"2026-04-23T10:00:00Z","message":{"id":"m1","model":"test-sonnet","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
{"type":"assistant","timestamp":"2026-04-23T10:01:00Z","message":{"id":"m2","model":"test-opus","usage":{"input_tokens":2000,"output_tokens":1000,"cache_read_input_tokens":5000,"cache_creation_input_tokens":0}}}
EOF

  run "${TOOL}" claude list --project -proj --json
  assert_success

  # Sonnet slice: 1000*3e-6 + 500*1.5e-5 = 0.003 + 0.0075 = 0.0105
  # Opus slice:   2000*1e-5 + 5000*1e-6 + 1000*5e-5 = 0.02 + 0.005 + 0.05 = 0.075
  # Total:        0.0855
  assert_float_near "$(jq '.totals.cost' <<<"${output}")" 0.0855

  local breakdown_len
  breakdown_len=$(jq '.sessions[0].model_breakdown | length' <<<"${output}")
  assert_equal "${breakdown_len}" 2

  local opus_cost sonnet_cost
  opus_cost=$(jq '.sessions[0].model_breakdown[] | select(.model=="test-opus") | .cost' <<<"${output}")
  sonnet_cost=$(jq '.sessions[0].model_breakdown[] | select(.model=="test-sonnet") | .cost' <<<"${output}")
  assert_float_near "${opus_cost}" 0.075
  assert_float_near "${sonnet_cost}" 0.0105
}

@test "claude: totals bucket by day across all projects" {
  write_session "-proj-a" "sa" <<'EOF'
{"type":"assistant","timestamp":"2026-04-21T10:00:00Z","message":{"id":"a1","model":"test-opus","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
EOF
  write_session "-proj-b" "sb" <<'EOF'
{"type":"assistant","timestamp":"2026-04-23T10:00:00Z","message":{"id":"b1","model":"test-opus","usage":{"input_tokens":200,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
EOF

  run "${TOOL}" claude totals --json
  assert_success

  # Both projects aggregated into two daily buckets.
  assert_equal "$(jq '.session_count' <<<"${output}")" 2
  assert_equal "$(jq '.buckets | length' <<<"${output}")" 2
  assert_equal "$(jq '.totals.tokens.input' <<<"${output}")" 300
  assert_equal "$(jq '.totals.tokens.output' <<<"${output}")" 150
}

@test "claude: --project scopes totals to a single project" {
  write_session "-proj-a" "sa" <<'EOF'
{"type":"assistant","timestamp":"2026-04-21T10:00:00Z","message":{"id":"a1","model":"test-opus","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
EOF
  write_session "-proj-b" "sb" <<'EOF'
{"type":"assistant","timestamp":"2026-04-23T10:00:00Z","message":{"id":"b1","model":"test-opus","usage":{"input_tokens":200,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
EOF

  run "${TOOL}" claude totals --project -proj-a --json
  assert_success
  assert_equal "$(jq '.session_count' <<<"${output}")" 1
  assert_equal "$(jq '.totals.tokens.input' <<<"${output}")" 100
  assert_equal "$(jq '.label' <<<"${output}")" '"-proj-a"'
}

@test "claude: totals --group-by week merges days into the same Monday bucket" {
  # 2026-04-21 is Tuesday, 2026-04-23 is Thursday - same ISO week (starts Monday 2026-04-20).
  write_session "-proj" "s1" <<'EOF'
{"type":"assistant","timestamp":"2026-04-21T10:00:00Z","message":{"id":"a1","model":"test-opus","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
EOF
  write_session "-proj" "s2" <<'EOF'
{"type":"assistant","timestamp":"2026-04-23T10:00:00Z","message":{"id":"b1","model":"test-opus","usage":{"input_tokens":200,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
EOF

  run "${TOOL}" claude totals --group-by week --json
  assert_success
  assert_equal "$(jq '.buckets | length' <<<"${output}")" 1
  assert_equal "$(jq -r '.buckets[0].period' <<<"${output}")" '2026-04-20'
  assert_equal "$(jq '.buckets[0].sessions' <<<"${output}")" 2
}

@test "claude: --no-cost skips pricing entirely" {
  # Delete the pricing cache so a fetch would be required. --no-cost must
  # mean no fetch attempt and no cost in the output.
  rm -rf "${XDG_CACHE_HOME}/ai-tool-usage"

  write_session "-proj" "s1" <<'EOF'
{"type":"assistant","timestamp":"2026-04-23T10:00:00Z","message":{"id":"m1","model":"test-opus","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
EOF

  run "${TOOL}" claude list --project -proj --no-cost --json
  assert_success
  assert_equal "$(jq '.totals.cost' <<<"${output}")" 0
  assert_equal "$(jq '.sessions[0] | has("cost")' <<<"${output}")" false
  # And no pricing cache was created.
  [[ ! -e "${XDG_CACHE_HOME}/ai-tool-usage/pricing.json" ]]
}

@test "claude: subagents get their own cost row" {
  # Parent session file and its subagent JSONL live in a parallel directory.
  local proj="${PROJECTS_DIR}/-proj"
  mkdir -p "${proj}/s1/subagents"
  cat >"${proj}/s1.jsonl" <<'EOF'
{"type":"assistant","timestamp":"2026-04-23T10:00:00Z","message":{"id":"m1","model":"test-opus","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
EOF
  cat >"${proj}/s1/subagents/sa1.jsonl" <<'EOF'
{"type":"assistant","timestamp":"2026-04-23T10:00:00Z","message":{"id":"sa_m1","model":"test-sonnet","usage":{"input_tokens":500,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
EOF

  run "${TOOL}" claude session s1 --project -proj --json
  assert_success

  assert_equal "$(jq '.subagents | length' <<<"${output}")" 1
  assert_equal "$(jq -r '.subagents[0].model' <<<"${output}")" 'test-sonnet'
  # 500*3e-6 + 200*1.5e-5 = 0.0015 + 0.003 = 0.0045
  assert_float_near "$(jq '.subagents[0].cost' <<<"${output}")" 0.0045
}

@test "claude: list errors when project cannot be derived" {
  run "${TOOL}" claude list
  assert_failure
  assert_output --partial 'Could not detect project'
}

@test "claude: preview extracted from first user message (string content)" {
  write_session "-proj" "s1" <<'EOF'
{"type":"user","timestamp":"2026-04-23T10:00:00Z","message":{"content":"<system-reminder>boilerplate</system-reminder>"}}
{"type":"user","timestamp":"2026-04-23T10:00:01Z","message":{"content":"refactor the\nauth module please"}}
{"type":"assistant","timestamp":"2026-04-23T10:00:02Z","message":{"id":"m1","model":"test-opus","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
EOF

  run "${TOOL}" claude list --project -proj --no-cost --json
  assert_success
  # system-reminder entry must be skipped; newline collapses to a space.
  assert_equal "$(jq -r '.sessions[0].preview' <<<"${output}")" 'refactor the auth module please'
}

@test "claude: preview extracted from first text block in array user content" {
  write_session "-proj" "s1" <<'EOF'
{"type":"user","timestamp":"2026-04-23T10:00:00Z","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"skipped"},{"type":"text","text":"kick off the bug fix"}]}}
{"type":"assistant","timestamp":"2026-04-23T10:00:01Z","message":{"id":"m1","model":"test-opus","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
EOF

  run "${TOOL}" claude list --project -proj --no-cost --json
  assert_success
  assert_equal "$(jq -r '.sessions[0].preview' <<<"${output}")" 'kick off the bug fix'
}
