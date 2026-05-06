#!/usr/bin/env bats
# Tests for config/opencode/session-usage.ts (invoked via dotenv/bin/ai-tool-usage).
# SPDX-License-Identifier: MIT
#
# opencode stores sessions in a sqlite DB (~/.local/share/opencode/opencode.db)
# rather than JSONL. Tests seed a minimal DB schema via node's built-in
# sqlite module and assert the adapter's behavior around last-assistant
# token extraction.

setup() {
  load '../../helpers/common'
  setup_isolated_home

  OPENCODE_DIR="${HOME}/.local/share/opencode"
  mkdir -p "${OPENCODE_DIR}"
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

# Seeds a minimal opencode.db at $OPENCODE_DIR/opencode.db with one session
# row and caller-provided assistant message rows. Each extra arg is a
# `id|time_created|data_json` triple consumed in order; `data_json` is the
# message JSON blob as a single line.
seed_db() {
  local sid="$1"
  local dir="$2"
  local created="$3"
  local updated="$4"
  shift 4
  local rows_js=""
  local i=0
  for row in "$@"; do
    local mid="${row%%|*}"
    local rest="${row#*|}"
    local mts="${rest%%|*}"
    local data="${rest#*|}"
    rows_js+="db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run('${mid}', '${sid}', ${mts}, ${mts}, ${data@Q});"
    ((i++)) || :
  done
  node --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync('${OPENCODE_DIR}/opencode.db');
    db.exec(\`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER)\`);
    db.exec(\`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)\`);
    db.exec(\`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)\`);
    db.prepare('INSERT INTO session (id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)')
      .run('${sid}', 'slug', '${dir}', 'title', '0.1.0', ${created}, ${updated});
    ${rows_js}
    db.close();
  "
}

@test "opencode: last_context_tokens comes from the final assistant message" {
  local user1='{"role":"user","time":{"created":1000}}'
  local asst1='{"role":"assistant","modelID":"qwen3","providerID":"litellm","cost":0,"tokens":{"total":2000,"input":100,"output":50,"reasoning":0,"cache":{"write":100,"read":1800}}}'
  local user2='{"role":"user","time":{"created":1002}}'
  local asst2='{"role":"assistant","modelID":"qwen3","providerID":"litellm","cost":0,"tokens":{"total":5000,"input":200,"output":80,"reasoning":0,"cache":{"write":0,"read":4700}}}'

  seed_db "ses_test0001" "/proj" 1000 1010 \
    "u1|1000|${user1}" \
    "a1|1001|${asst1}" \
    "u2|1002|${user2}" \
    "a2|1003|${asst2}"

  # Redirect node-sqlite's ExperimentalWarning out of stdout/stderr so `run`
  # captures pure JSON. The underlying adapter already handles the warning
  # upstream; it's only surfaced in test runs.
  run bash -c "'${TOOL}' opencode list --project /proj --json 2>/dev/null"
  assert_success

  # Last assistant row (a2): 200 + 0 + 4700 = 4900.
  assert_equal "$(jq '.sessions[0].last_context_tokens' <<<"${output}")" 4900
}
