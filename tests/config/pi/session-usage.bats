#!/usr/bin/env bats
# Tests for config/pi/session-usage.ts (invoked via dotenv/bin/ai-tool-usage).
# SPDX-License-Identifier: MIT
#
# Pi records real cost in each assistant message's `usage.cost.total`, so
# unlike claude/codex we never consult the LiteLLM pricing table. These
# tests focus on pi-specific behavior: session header parsing, custom
# subagent-run entries, and the `subagents/<parent-id>/` child layout.

setup() {
  load '../../helpers/common'
  setup_isolated_home

  SESSIONS_DIR="${HOME}/.pi/agent/sessions"
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
}

# Writes a JSONL parent session file at
# $SESSIONS_DIR/<slug>/<timestamp>_<sid>.jsonl from stdin.
write_session() {
  local slug="$1"
  local sid="$2"
  local proj="${SESSIONS_DIR}/${slug}"
  mkdir -p "${proj}"
  local ts="${3:-2026-05-01T19-00-00-000Z}"
  cat >"${proj}/${ts}_${sid}.jsonl"
}

# Writes a subagent child JSONL under
# $SESSIONS_DIR/<slug>/subagents/<parent-sid>/<timestamp>_<child-sid>.jsonl.
write_subagent() {
  local slug="$1"
  local parent_sid="$2"
  local child_sid="$3"
  local dir="${SESSIONS_DIR}/${slug}/subagents/${parent_sid}"
  mkdir -p "${dir}"
  local ts="${4:-2026-05-01T19-01-00-000Z}"
  cat >"${dir}/${ts}_${child_sid}.jsonl"
}

@test "pi: parent session tokens and cost come from assistant usage field" {
  write_session "--proj--" "019dd000-aaaa-7000-0000-000000000001" <<'EOF'
{"type":"session","version":3,"id":"019dd000-aaaa-7000-0000-000000000001","timestamp":"2026-05-01T19:00:00.000Z","cwd":"/proj"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-01T19:00:01.000Z","message":{"role":"user","content":"hi"}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-05-01T19:00:02.000Z","message":{"role":"assistant","model":"claude-opus-4","provider":"anthropic","content":[{"type":"text","text":"hello"}],"usage":{"input":100,"output":50,"cacheRead":1000,"cacheWrite":200,"cost":{"input":0.001,"output":0.002,"cacheRead":0.0001,"cacheWrite":0.00025,"total":0.00335}}}}
EOF

  run "${TOOL}" pi list --project /proj --json
  assert_success

  assert_equal "$(jq '.totals.tokens.input' <<<"${output}")" 100
  assert_equal "$(jq '.totals.tokens.output' <<<"${output}")" 50
  assert_equal "$(jq '.totals.tokens.cache_read' <<<"${output}")" 1000
  assert_equal "$(jq '.totals.tokens.cache_write' <<<"${output}")" 200
  assert_equal "$(jq '.sessions[0].cost' <<<"${output}")" 0.00335
  assert_equal "$(jq '.sessions[0].subagent_count' <<<"${output}")" 0
  # Last-turn context = m2's input + cacheRead + cacheWrite = 100 + 1000 + 200.
  assert_equal "$(jq '.sessions[0].last_context_tokens' <<<"${output}")" 1300
}

@test "pi: last_context_tokens reflects most recent assistant turn across model_change" {
  # Two assistant turns with different models; the last turn's context is
  # what the CLI should report regardless of which model dominated totals.
  write_session "--proj--" "019dd000-aaaa-7000-0000-000000000010" <<'EOF'
{"type":"session","version":3,"id":"019dd000-aaaa-7000-0000-000000000010","timestamp":"2026-05-01T19:00:00.000Z","cwd":"/proj"}
{"type":"model_change","id":"mc1","parentId":null,"timestamp":"2026-05-01T19:00:00.100Z","provider":"anthropic","modelId":"claude-opus-4"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-01T19:00:01.000Z","message":{"role":"user","content":"hi"}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-05-01T19:00:02.000Z","message":{"role":"assistant","model":"claude-opus-4","content":[{"type":"text","text":"hi back"}],"usage":{"input":10,"output":5,"cacheRead":5000,"cacheWrite":0,"cost":{"total":0.001}}}}
{"type":"model_change","id":"mc2","parentId":"m2","timestamp":"2026-05-01T19:00:03.000Z","provider":"anthropic","modelId":"claude-sonnet-4"}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-05-01T19:00:04.000Z","message":{"role":"user","content":"again"}}
{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-05-01T19:00:05.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"later"}],"usage":{"input":3,"output":2,"cacheRead":8000,"cacheWrite":50,"cost":{"total":0.0005}}}}
EOF

  run "${TOOL}" pi list --project /proj --json
  assert_success

  # Last turn is m4 (sonnet): 3 + 8000 + 50 = 8053.
  assert_equal "$(jq '.sessions[0].last_context_tokens' <<<"${output}")" 8053
}

@test "pi: subagent_count reflects files under subagents/<parent-id>/" {
  write_session "--proj--" "019dd000-aaaa-7000-0000-000000000001" <<'EOF'
{"type":"session","version":3,"id":"019dd000-aaaa-7000-0000-000000000001","timestamp":"2026-05-01T19:00:00.000Z","cwd":"/proj"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-01T19:00:01.000Z","message":{"role":"user","content":"spawn some agents"}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-05-01T19:00:02.000Z","message":{"role":"assistant","model":"claude-opus-4","provider":"anthropic","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.001}}}}
EOF
  # Two child session files under the parent's subagents dir.
  write_subagent "--proj--" "019dd000-aaaa-7000-0000-000000000001" "019dd000-bbbb-7000-0000-000000000002" <<'EOF'
{"type":"session","version":3,"id":"019dd000-bbbb-7000-0000-000000000002","timestamp":"2026-05-01T19:01:00.000Z","cwd":"/proj"}
EOF
  write_subagent "--proj--" "019dd000-aaaa-7000-0000-000000000001" "019dd000-cccc-7000-0000-000000000003" "2026-05-01T19-02-00-000Z" <<'EOF'
{"type":"session","version":3,"id":"019dd000-cccc-7000-0000-000000000003","timestamp":"2026-05-01T19:02:00.000Z","cwd":"/proj"}
EOF

  run "${TOOL}" pi list --project /proj --json
  assert_success

  assert_equal "$(jq '.sessions | length' <<<"${output}")" 1
  assert_equal "$(jq '.sessions[0].subagent_count' <<<"${output}")" 2
}

@test "pi: listed sessions exclude files inside subagents/ subdirs" {
  # A malformed layout: the parent file sits next to a lone subagents/ dir
  # containing a child jsonl. The child must NOT appear as a top-level row.
  write_session "--proj--" "019dd000-aaaa-7000-0000-000000000001" <<'EOF'
{"type":"session","version":3,"id":"019dd000-aaaa-7000-0000-000000000001","timestamp":"2026-05-01T19:00:00.000Z","cwd":"/proj"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-01T19:00:01.000Z","message":{"role":"user","content":"hi"}}
EOF
  write_subagent "--proj--" "019dd000-aaaa-7000-0000-000000000001" "019dd000-bbbb-7000-0000-000000000002" <<'EOF'
{"type":"session","version":3,"id":"019dd000-bbbb-7000-0000-000000000002","timestamp":"2026-05-01T19:01:00.000Z","cwd":"/proj"}
EOF

  run "${TOOL}" pi list --project /proj --json
  assert_success
  assert_equal "$(jq '.sessions | length' <<<"${output}")" 1
  assert_equal "$(jq -r '.sessions[0].session_id' <<<"${output}")" '019dd000-aaaa-7000-0000-000000000001'
}

@test "pi: session detail enriches subagents with agent label and task from parent" {
  write_session "--proj--" "019dd000-aaaa-7000-0000-000000000001" <<'EOF'
{"type":"session","version":3,"id":"019dd000-aaaa-7000-0000-000000000001","timestamp":"2026-05-01T19:00:00.000Z","cwd":"/proj"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-01T19:00:01.000Z","message":{"role":"user","content":"run explore"}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-05-01T19:00:02.000Z","message":{"role":"assistant","model":"claude-opus-4","provider":"anthropic","content":[{"type":"toolCall","id":"tc1","name":"subagent","arguments":{"agent":"explore","task":"look at X"}}],"usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.002}}}}
{"type":"custom","customType":"subagent-run","id":"cu1","parentId":"m2","timestamp":"2026-05-01T19:00:30.000Z","data":{"agent":"explore","agentSource":"global","task":"Look at X and summarize.","model":"claude-sonnet-4","turns":1,"tokens":{"input":20,"cacheRead":500,"cacheWrite":100,"output":40},"cost":0.0025,"durationMs":12000,"stopReason":"completed","workspace":{"isolation":"shared-cwd"},"childSessionId":"019dd000-bbbb-7000-0000-000000000002","handle":"sub_explore_1"}}
EOF
  write_subagent "--proj--" "019dd000-aaaa-7000-0000-000000000001" "019dd000-bbbb-7000-0000-000000000002" <<'EOF'
{"type":"session","version":3,"id":"019dd000-bbbb-7000-0000-000000000002","timestamp":"2026-05-01T19:01:00.000Z","cwd":"/proj"}
{"type":"message","id":"cm1","parentId":null,"timestamp":"2026-05-01T19:01:01.000Z","message":{"role":"user","content":"Look at X and summarize."}}
{"type":"message","id":"cm2","parentId":"cm1","timestamp":"2026-05-01T19:01:02.000Z","message":{"role":"assistant","model":"claude-sonnet-4","provider":"anthropic","content":[{"type":"toolCall","id":"ctc1","name":"read","arguments":{}},{"type":"text","text":"summary"}],"usage":{"input":20,"output":40,"cacheRead":500,"cacheWrite":100,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.0025}}}}
EOF

  run "${TOOL}" pi session 019dd000-aaaa --project /proj --json
  assert_success

  assert_equal "$(jq '.subagents | length' <<<"${output}")" 1
  assert_equal "$(jq -r '.subagents[0].agent_id' <<<"${output}")" '019dd000-bbbb-7000-0000-000000000002'
  assert_equal "$(jq -r '.subagents[0].agent_label' <<<"${output}")" 'explore'
  assert_equal "$(jq -r '.subagents[0].role' <<<"${output}")" 'sub_explore_1'
  assert_equal "$(jq -r '.subagents[0].description' <<<"${output}")" 'Look at X and summarize.'
  # Child tokens come from the child jsonl, not the parent's custom entry.
  assert_equal "$(jq -r '.subagents[0].model' <<<"${output}")" 'claude-sonnet-4'
  assert_equal "$(jq '.subagents[0].tokens.output' <<<"${output}")" 40
  assert_equal "$(jq '.subagents[0].cost' <<<"${output}")" 0.0025
  assert_equal "$(jq '.subagents[0].tool_calls' <<<"${output}")" 1
  assert_equal "$(jq -r '.subagents[0].tool_breakdown.read' <<<"${output}")" '1'
}

@test "pi: subagent without a matching subagent-run entry still renders (orphan child)" {
  # A stale/crash-orphan child transcript should still produce a subagent row.
  # The agent label/task are empty but tokens still flow through.
  write_session "--proj--" "019dd000-aaaa-7000-0000-000000000001" <<'EOF'
{"type":"session","version":3,"id":"019dd000-aaaa-7000-0000-000000000001","timestamp":"2026-05-01T19:00:00.000Z","cwd":"/proj"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-01T19:00:01.000Z","message":{"role":"user","content":"hi"}}
EOF
  write_subagent "--proj--" "019dd000-aaaa-7000-0000-000000000001" "019dd000-bbbb-7000-0000-000000000002" <<'EOF'
{"type":"session","version":3,"id":"019dd000-bbbb-7000-0000-000000000002","timestamp":"2026-05-01T19:01:00.000Z","cwd":"/proj"}
{"type":"message","id":"cm1","parentId":null,"timestamp":"2026-05-01T19:01:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4","provider":"anthropic","content":[{"type":"text","text":"orphan"}],"usage":{"input":7,"output":3,"cacheRead":0,"cacheWrite":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.0007}}}}
EOF

  run "${TOOL}" pi session 019dd000-aaaa --project /proj --json
  assert_success
  assert_equal "$(jq '.subagents | length' <<<"${output}")" 1
  assert_equal "$(jq -r '.subagents[0].agent_label' <<<"${output}")" ''
  assert_equal "$(jq '.subagents[0].tokens.input' <<<"${output}")" 7
  assert_equal "$(jq '.subagents[0].cost' <<<"${output}")" 0.0007
}

@test "pi: totals count parent tokens only, not subagent child tokens" {
  # Matches claude/codex semantics: list/totals surface the parent's usage,
  # subagent tokens show up exclusively on `session <uuid>` detail rows.
  write_session "--proj--" "019dd000-aaaa-7000-0000-000000000001" <<'EOF'
{"type":"session","version":3,"id":"019dd000-aaaa-7000-0000-000000000001","timestamp":"2026-05-01T19:00:00.000Z","cwd":"/proj"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-01T19:00:01.000Z","message":{"role":"user","content":"hi"}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-05-01T19:00:02.000Z","message":{"role":"assistant","model":"claude-opus-4","provider":"anthropic","content":[{"type":"text","text":"hello"}],"usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.01}}}}
EOF
  write_subagent "--proj--" "019dd000-aaaa-7000-0000-000000000001" "019dd000-bbbb-7000-0000-000000000002" <<'EOF'
{"type":"session","version":3,"id":"019dd000-bbbb-7000-0000-000000000002","timestamp":"2026-05-01T19:01:00.000Z","cwd":"/proj"}
{"type":"message","id":"cm1","parentId":null,"timestamp":"2026-05-01T19:01:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4","provider":"anthropic","content":[{"type":"text","text":"sub"}],"usage":{"input":999,"output":888,"cacheRead":0,"cacheWrite":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.5}}}}
EOF

  run "${TOOL}" pi totals --project /proj --json
  assert_success
  assert_equal "$(jq '.totals.tokens.input' <<<"${output}")" 100
  assert_equal "$(jq '.totals.tokens.output' <<<"${output}")" 50
  assert_equal "$(jq '.totals.cost' <<<"${output}")" 0.01
  assert_equal "$(jq '.session_count' <<<"${output}")" 1
}

@test "pi: session detail tolerates missing subagents directory" {
  write_session "--proj--" "019dd000-aaaa-7000-0000-000000000001" <<'EOF'
{"type":"session","version":3,"id":"019dd000-aaaa-7000-0000-000000000001","timestamp":"2026-05-01T19:00:00.000Z","cwd":"/proj"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-01T19:00:01.000Z","message":{"role":"user","content":"hi"}}
EOF

  run "${TOOL}" pi session 019dd000-aaaa --project /proj --json
  assert_success
  assert_equal "$(jq '.subagents | length' <<<"${output}")" 0
  assert_equal "$(jq '.subagent_count' <<<"${output}")" 0
}

@test "pi: preview extracted from first user message" {
  write_session "--proj--" "019dd000-aaaa-7000-0000-000000000001" <<'EOF'
{"type":"session","version":3,"id":"019dd000-aaaa-7000-0000-000000000001","timestamp":"2026-05-01T19:00:00.000Z","cwd":"/proj"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-01T19:00:01.000Z","message":{"role":"user","content":"fix the auth bug\nand add a test"}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-05-01T19:00:02.000Z","message":{"role":"user","content":"follow-up prompt"}}
EOF

  run "${TOOL}" pi list --project /proj --json
  assert_success
  # Only the first user message seeds the preview; newlines collapse.
  assert_equal "$(jq -r '.sessions[0].preview' <<<"${output}")" 'fix the auth bug and add a test'
}

@test "pi: preview picks up TextContent blocks from array-shaped user content" {
  write_session "--proj--" "019dd000-aaaa-7000-0000-000000000001" <<'EOF'
{"type":"session","version":3,"id":"019dd000-aaaa-7000-0000-000000000001","timestamp":"2026-05-01T19:00:00.000Z","cwd":"/proj"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-01T19:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"refactor the loader"},{"type":"image","data":"...","mimeType":"image/png"}]}}
EOF

  run "${TOOL}" pi list --project /proj --json
  assert_success
  assert_equal "$(jq -r '.sessions[0].preview' <<<"${output}")" 'refactor the loader'
}

@test "pi: user-set title takes priority over auto preview in detail header" {
  write_session "--proj--" "019dd000-aaaa-7000-0000-000000000001" <<'EOF'
{"type":"session","version":3,"id":"019dd000-aaaa-7000-0000-000000000001","timestamp":"2026-05-01T19:00:00.000Z","cwd":"/proj"}
{"type":"session_info","id":"si1","parentId":null,"timestamp":"2026-05-01T19:00:00.500Z","name":"Refactor auth"}
{"type":"message","id":"m1","parentId":"si1","timestamp":"2026-05-01T19:00:01.000Z","message":{"role":"user","content":"fix the auth bug"}}
EOF

  run "${TOOL}" pi session 019dd000-aaaa --project /proj --json
  assert_success
  assert_equal "$(jq -r '.title' <<<"${output}")" 'Refactor auth'
  # Preview still populated so --json consumers can get both signals.
  assert_equal "$(jq -r '.preview' <<<"${output}")" 'fix the auth bug'

  run "${TOOL}" pi session 019dd000-aaaa --project /proj --no-color
  assert_success
  # Text output: show Title line but NOT a Preview line when title is set.
  assert_line --partial 'Title    Refactor auth'
  refute_line --partial 'Preview  fix the auth bug'
}
