#!/usr/bin/env node
// opencode session log usage summarizer
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { runSessionUsageCli, type SessionUsageAdapter } from '../../lib/node/ai-tooling/cli.ts';
import {
  defaultOpencodeDataDir,
  isOpencodeV2,
  OPENCODE_SESSION_COLUMNS,
  OPENCODE_V2_REQUIRED,
  type OpencodeSessionRow,
  type OpencodeSessionStats,
  readOpencodeMessages,
  resolveOpencodeDbPath,
  summarizeOpencodeMessages,
} from '../../lib/node/ai-tooling/opencode-db.ts';
import { resolveProjectPath } from '../../lib/node/ai-tooling/paths.ts';
import { type SessionDetail, type SessionSummary, type Subagent } from '../../lib/node/ai-tooling/types.ts';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface OpencodeContext {
  db: DatabaseSync;
  filterCwd: string;
  subagentIndex: Map<string, OpencodeSessionRow[]>;
}

function openDb(dbPath: string): DatabaseSync {
  if (!fs.existsSync(dbPath)) {
    console.error(`opencode database not found: ${dbPath}`);
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  if (!isOpencodeV2(db)) {
    console.error(`${OPENCODE_V2_REQUIRED}: ${dbPath}`);
    process.exit(1);
  }
  return db;
}

function buildSubagentIndex(db: DatabaseSync): Map<string, OpencodeSessionRow[]> {
  const index = new Map<string, OpencodeSessionRow[]>();
  const rows = db
    .prepare(`SELECT ${OPENCODE_SESSION_COLUMNS} FROM session_v2 WHERE parent_id IS NOT NULL`)
    .all() as unknown as OpencodeSessionRow[];
  for (const r of rows) {
    if (!r.parent_id) continue;
    const list = index.get(r.parent_id) ?? [];
    list.push(r);
    index.set(r.parent_id, list);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------

function parseSessionData(db: DatabaseSync, sessionId: string): OpencodeSessionStats {
  return summarizeOpencodeMessages(readOpencodeMessages(db, sessionId));
}

function rowToSummary(row: OpencodeSessionRow, parsed: OpencodeSessionStats, subagentCount: number): SessionSummary {
  const durationSecs =
    row.time_created && row.time_updated ? Math.max(0, Math.floor((row.time_updated - row.time_created) / 1000)) : 0;

  const summary: SessionSummary = {
    sessionId: row.id,
    model: parsed.model,
    startTime: row.time_created ? new Date(row.time_created).toISOString() : '',
    endTime: row.time_updated ? new Date(row.time_updated).toISOString() : '',
    durationSecs,
    userTurns: parsed.userTurns,
    tokens: parsed.tokens,
    toolCalls: parsed.toolCalls,
    toolBreakdown: parsed.toolBreakdown,
    subagentCount,
  };
  if (row.title) summary.title = row.title;
  if (parsed.agent) summary.agent = parsed.agent;
  if (row.directory) summary.directory = row.directory;
  if (row.version) summary.version = row.version;
  if (parsed.cost > 0) summary.cost = parsed.cost;
  if (parsed.lastContextTokens !== undefined) summary.lastContextTokens = parsed.lastContextTokens;
  return summary;
}

function rowToSubagent(db: DatabaseSync, row: OpencodeSessionRow): Subagent {
  const parsed = parseSessionData(db, row.id);
  const sa: Subagent = {
    agentId: row.id,
    agentLabel: parsed.agent,
    model: parsed.model,
    tokens: parsed.tokens,
    toolCalls: parsed.toolCalls,
    toolBreakdown: parsed.toolBreakdown,
  };
  if (row.title) sa.description = row.title;
  if (parsed.cost > 0) sa.cost = parsed.cost;
  return sa;
}

// ---------------------------------------------------------------------------
// Adapter operations
// ---------------------------------------------------------------------------

function listSessions(ctx: OpencodeContext): SessionSummary[] {
  const rows = ctx.db
    .prepare(
      `SELECT ${OPENCODE_SESSION_COLUMNS} FROM session_v2 WHERE parent_id IS NULL AND (directory = ? OR directory LIKE ?) ORDER BY time_updated DESC`,
    )
    .all(ctx.filterCwd, `${ctx.filterCwd}/%`) as unknown as OpencodeSessionRow[];

  return rows.map((r) => rowToSummary(r, parseSessionData(ctx.db, r.id), ctx.subagentIndex.get(r.id)?.length ?? 0));
}

function listAllSessions(ctx: OpencodeContext): SessionSummary[] {
  const rows = ctx.db
    .prepare(`SELECT ${OPENCODE_SESSION_COLUMNS} FROM session_v2 WHERE parent_id IS NULL ORDER BY time_updated DESC`)
    .all() as unknown as OpencodeSessionRow[];

  return rows.map((r) => rowToSummary(r, parseSessionData(ctx.db, r.id), ctx.subagentIndex.get(r.id)?.length ?? 0));
}

function resolveSessionRow(db: DatabaseSync, sessionId: string): OpencodeSessionRow {
  const exact = db
    .prepare(`SELECT ${OPENCODE_SESSION_COLUMNS} FROM session_v2 WHERE id = ?`)
    .get(sessionId) as unknown as OpencodeSessionRow | undefined;
  if (exact) return exact;

  const matches = db
    .prepare(`SELECT ${OPENCODE_SESSION_COLUMNS} FROM session_v2 WHERE id LIKE ?`)
    .all(`${sessionId}%`) as unknown as OpencodeSessionRow[];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`Ambiguous session prefix "${sessionId}", matches:`);
    for (const r of matches) console.error(`  ${r.id}`);
    process.exit(1);
  }

  console.error(`Session not found: ${sessionId}`);
  process.exit(1);
}

function loadSessionDetail(ctx: OpencodeContext, sessionId: string): SessionDetail {
  const row = resolveSessionRow(ctx.db, sessionId);
  const parsed = parseSessionData(ctx.db, row.id);
  const subagentRows = ctx.subagentIndex.get(row.id) ?? [];
  const summary = rowToSummary(row, parsed, subagentRows.length);
  return { ...summary, subagents: subagentRows.map((sr) => rowToSubagent(ctx.db, sr)) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `Usage: session-usage.ts [command] [options]

Commands:
  list                 List all sessions (default)
  session <id>         Detailed single-session report
  totals               Usage totals bucketed by day or week. Aggregates across
                       all projects unless --project is given.

Options:
  --project, -p <path> Filter sessions by project directory (default: $PWD)
  --user-dir, -u <dir> Directory containing opencode.db (default: $OPENCODE_DB,
                       else ~/.local/share/opencode)
  --json               Machine-readable JSON output
  --sort <field>       list: date, tokens, duration, tools, cost
                       totals: date, tokens, tools, cost (default: date)
  --limit, -n <N>      Limit to N rows
  --group-by, -g <p>   totals period: day or week (default: day)
  --no-color           Disable ANSI colors
  -h, --help           Show this help

Requires an opencode v2 database (session_v2 / session_message tables).
opencode records real costs in its session DB; the shared --no-cost and
--refresh-prices flags are no-ops for this tool.`;

const adapter: SessionUsageAdapter<OpencodeContext> = {
  help: HELP,
  defaultUserDir: defaultOpencodeDataDir(),
  resolveContext(args) {
    const db = openDb(resolveOpencodeDbPath(args.userDir));
    return {
      db,
      filterCwd: resolveProjectPath(args.projectArg),
      subagentIndex: buildSubagentIndex(db),
    };
  },
  listSessions,
  listAllSessions,
  loadSessionDetail,
};

runSessionUsageCli(adapter).catch((err) => {
  console.error(err);
  process.exit(1);
});
