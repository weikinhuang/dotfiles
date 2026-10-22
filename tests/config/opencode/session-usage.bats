#!/usr/bin/env bats
# Tests for config/opencode/session-usage.ts (invoked via dotenv/bin/ai-tool-usage).
# SPDX-License-Identifier: MIT
#
# opencode stores sessions in a sqlite DB (~/.local/share/opencode/opencode.db)
# rather than JSONL. Tests seed a minimal opencode v2 schema (session_v2 +
# session_message) via node's built-in sqlite module.

setup() {
  load '../../helpers/common'
  setup_isolated_home
  unset OPENCODE_DB XDG_DATA_HOME

  OPENCODE_DIR="${HOME}/.local/share/opencode"
  mkdir -p "${OPENCODE_DIR}"
  DB_PATH="${OPENCODE_DIR}/opencode.db"
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

# Adds one session (and its messages) to the v2 DB at $DB_PATH, creating the
# schema on first use. Args: <session-id> <parent-id or -> <directory>
# <time_created> <time_updated> [<type>|<data_json> ...]. Messages get
# increasing `seq` values in argument order.
seed_session() {
  local sid="$1"
  local parent="$2"
  local dir="$3"
  local created="$4"
  local updated="$5"
  shift 5
  local parent_js="null"
  [[ "${parent}" != "-" ]] && parent_js="'${parent}'"
  local rows_js=""
  local seq=0
  for row in "$@"; do
    local type="${row%%|*}"
    local data="${row#*|}"
    ((seq++)) || :
    rows_js+="db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run('${sid}_${seq}', '${sid}', '${type}', ${seq}, ${created}, ${created}, ${data@Q});"
  done
  node --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync('${DB_PATH}');
    db.exec(\`CREATE TABLE IF NOT EXISTS session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)\`);
    db.exec(\`CREATE TABLE IF NOT EXISTS session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)\`);
    db.prepare('INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('${sid}', 'proj', ${parent_js}, 'slug', '${dir}', 'title ${sid}', '2.1.3', ${created}, ${updated});
    ${rows_js}
    db.close();
  "
}

# Assistant message JSON with the given model, input, cache read, and tool names.
asst() {
  local model="$1" input="$2" read="$3"
  shift 3
  local tools=""
  local t
  for t in "$@"; do
    tools+=",{\"type\":\"tool\",\"name\":\"${t}\",\"state\":{\"status\":\"completed\"}}"
  done
  printf '{"agent":"build","model":{"id":"%s","providerID":"litellm"},"cost":0.5,"tokens":{"input":%s,"output":50,"reasoning":5,"cache":{"write":0,"read":%s}},"content":[{"type":"text","text":"ok"}%s]}' \
    "${model}" "${input}" "${read}" "${tools}"
}

@test "opencode: last_context_tokens comes from the final assistant message" {
  seed_session "ses_test0001" - "/proj" 1000 11000 \
    'user|{"text":"one"}' \
    "assistant|$(asst qwen3 100 1800)" \
    'synthetic|{"text":"Instructions from: AGENTS.md"}' \
    'user|{"text":"two"}' \
    "assistant|$(asst qwen3 200 4700)" \
    'idle|{"outcome":"succeeded"}'

  # Redirect node-sqlite's ExperimentalWarning out of stdout/stderr so `run`
  # captures pure JSON.
  run bash -c "'${TOOL}' opencode list --project /proj --json 2>/dev/null"
  assert_success

  # Last assistant row: 200 + 0 + 4700 = 4900.
  assert_equal "$(jq '.sessions[0].last_context_tokens' <<<"${output}")" 4900
  assert_equal "$(jq '.sessions[0].user_turns' <<<"${output}")" 2
  assert_equal "$(jq -r '.sessions[0].model' <<<"${output}")" qwen3
  assert_equal "$(jq '.sessions[0].tokens.input' <<<"${output}")" 300
  assert_equal "$(jq '.sessions[0].tokens.cache_read' <<<"${output}")" 6500
  assert_equal "$(jq '.sessions[0].duration_seconds' <<<"${output}")" 10
}

@test "opencode: list filters by project and counts subagents" {
  seed_session "ses_parent01" - "/proj" 1000 2000 'user|{"text":"go"}' "assistant|$(asst m 10 0 subagent)"
  seed_session "ses_child001" "ses_parent01" "/proj" 1100 1900 'user|{"text":"sub"}' "assistant|$(asst m 5 0 read)"
  seed_session "ses_other001" - "/elsewhere" 1000 2000 'user|{"text":"x"}'

  run bash -c "'${TOOL}' opencode list --project /proj --json 2>/dev/null"
  assert_success
  assert_equal "$(jq '.sessions | length' <<<"${output}")" 1
  assert_equal "$(jq -r '.sessions[0].session_id' <<<"${output}")" ses_parent01
  assert_equal "$(jq '.sessions[0].subagent_count' <<<"${output}")" 1
}

@test "opencode: session detail tallies inline tool items and lists subagents" {
  seed_session "ses_detail01" - "/proj" 1000 2000 \
    'user|{"text":"go"}' \
    "assistant|$(asst m 10 0 read read glob)" \
    "assistant|$(asst m 10 20 shell)"
  seed_session "ses_detail02" "ses_detail01" "/proj" 1100 1900 "assistant|$(asst sub 5 0 read)"

  run bash -c "'${TOOL}' opencode session ses_detail01 --json 2>/dev/null"
  assert_success
  assert_equal "$(jq '.tool_calls' <<<"${output}")" 4
  assert_equal "$(jq -c '.tool_breakdown' <<<"${output}")" '{"read":2,"glob":1,"shell":1}'
  assert_equal "$(jq '.cost' <<<"${output}")" 1
  assert_equal "$(jq -r '.subagents[0].agent_id' <<<"${output}")" ses_detail02
  assert_equal "$(jq -r '.subagents[0].model' <<<"${output}")" sub
}

@test "opencode: OPENCODE_DB is used when --user-dir is not given" {
  DB_PATH="${BATS_TEST_TMPDIR}/profile/opencode.db"
  mkdir -p "${DB_PATH%/*}"
  seed_session "ses_profile1" - "/proj" 1000 2000 'user|{"text":"p"}' "assistant|$(asst m 1 0)"

  run bash -c "OPENCODE_DB='${DB_PATH}' '${TOOL}' opencode list --project /proj --json 2>/dev/null"
  assert_success
  assert_equal "$(jq -r '.sessions[0].session_id' <<<"${output}")" ses_profile1

  run bash -c "OPENCODE_DB=/nonexistent.db '${TOOL}' opencode list --user-dir '${DB_PATH%/*}' --project /proj --json 2>/dev/null"
  assert_success
  assert_equal "$(jq -r '.sessions[0].session_id' <<<"${output}")" ses_profile1
}

@test "opencode: a v1 database fails with a clear error" {
  node --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync('${DB_PATH}');
    db.exec('CREATE TABLE session (id TEXT); CREATE TABLE message (id TEXT); CREATE TABLE part (id TEXT);');
    db.close();
  "

  run bash -c "'${TOOL}' opencode list --project /proj 2>&1"
  assert_failure
  assert_output --partial "opencode v2 database required"
}
