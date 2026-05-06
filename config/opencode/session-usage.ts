#!/usr/bin/env node
// opencode session log usage summarizer
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { runSessionUsageCli, type SessionUsageAdapter } from '../../lib/node/ai-tooling/cli.ts';
import { resolveProjectPath } from '../../lib/node/ai-tooling/paths.ts';
import {
  type SessionDetail,
  type SessionSummary,
  type SessionTokens,
  type Subagent,
} from '../../lib/node/ai-tooling/types.ts';

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  parent_id: string | null;
  slug: string;
  directory: string;
  title: string;
  version: string;
  time_created: number;
  time_updated: number;
}

interface MessageRow {
  id: string;
  data: string;
}

interface PartRow {
  data: string;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface OpencodeContext {
  db: DatabaseSync;
  filterCwd: string;
  subagentIndex: Map<string, SessionRow[]>;
}

const SESSION_COLUMNS = 'id, parent_id, slug, directory, title, version, time_created, time_updated';

function openDb(dataDir: string): DatabaseSync {
  const dbPath = path.join(dataDir, 'opencode.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`opencode database not found: ${dbPath}`);
    process.exit(1);
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

function buildSubagentIndex(db: DatabaseSync): Map<string, SessionRow[]> {
  const index = new Map<string, SessionRow[]>();
  const rows = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE parent_id IS NOT NULL`)
    .all() as unknown as SessionRow[];
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

interface ParsedSession {
  userTurns: number;
  model: string;
  agent: string;
  cost: number;
  tokens: SessionTokens;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  lastContextTokens?: number;
}

interface OpencodeMessageTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { write?: number; read?: number };
}

interface OpencodeMessageData {
  role?: string;
  agent?: string;
  modelID?: string;
  cost?: number;
  tokens?: OpencodeMessageTokens;
}

interface OpencodePartData {
  type?: string;
  tool?: string;
}

function parseSessionData(db: DatabaseSync, sessionId: string): ParsedSession {
  const messages = db
    .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created')
    .all(sessionId) as unknown as MessageRow[];

  let userTurns = 0;
  let model = '';
  let agent = '';
  let cost = 0;
  const tokens: SessionTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const assistantMessageIds: string[] = [];
  // Context consumed on the most recent assistant turn. Messages are ordered
  // by time_created, so the last assistant row encountered is the latest
  // completed turn. Context = input + cache.write + cache.read.
  let lastContextTokens: number | undefined;

  for (const m of messages) {
    let d: OpencodeMessageData;
    try {
      d = JSON.parse(m.data) as OpencodeMessageData;
    } catch {
      continue;
    }
    if (d.role === 'user') {
      userTurns++;
    } else if (d.role === 'assistant') {
      assistantMessageIds.push(m.id);
      if (!agent && typeof d.agent === 'string') agent = d.agent;
      if (typeof d.modelID === 'string' && d.modelID) model = d.modelID;
      if (typeof d.cost === 'number') cost += d.cost;
      const t: OpencodeMessageTokens = d.tokens ?? {};
      tokens.input += t.input ?? 0;
      tokens.output += t.output ?? 0;
      tokens.reasoning! += t.reasoning ?? 0;
      tokens.cacheWrite! += t.cache?.write ?? 0;
      tokens.cacheRead += t.cache?.read ?? 0;
      const turnInput = (t.input ?? 0) + (t.cache?.write ?? 0) + (t.cache?.read ?? 0);
      if (turnInput > 0) lastContextTokens = turnInput;
    }
  }

  const toolBreakdown: Record<string, number> = {};
  let toolCalls = 0;

  if (assistantMessageIds.length > 0) {
    const placeholders = assistantMessageIds.map(() => '?').join(',');
    const parts = db
      .prepare(`SELECT data FROM part WHERE message_id IN (${placeholders})`)
      .all(...assistantMessageIds) as unknown as PartRow[];
    for (const p of parts) {
      let d: OpencodePartData;
      try {
        d = JSON.parse(p.data) as OpencodePartData;
      } catch {
        continue;
      }
      if (d.type === 'tool' && typeof d.tool === 'string') {
        toolCalls++;
        toolBreakdown[d.tool] = (toolBreakdown[d.tool] ?? 0) + 1;
      }
    }
  }

  return { userTurns, model, agent, cost, tokens, toolCalls, toolBreakdown, lastContextTokens };
}

function rowToSummary(row: SessionRow, parsed: ParsedSession, subagentCount: number): SessionSummary {
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

function rowToSubagent(db: DatabaseSync, row: SessionRow): Subagent {
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
      `SELECT ${SESSION_COLUMNS} FROM session WHERE parent_id IS NULL AND (directory = ? OR directory LIKE ?) ORDER BY time_updated DESC`,
    )
    .all(ctx.filterCwd, `${ctx.filterCwd}/%`) as unknown as SessionRow[];

  return rows.map((r) => rowToSummary(r, parseSessionData(ctx.db, r.id), ctx.subagentIndex.get(r.id)?.length ?? 0));
}

function listAllSessions(ctx: OpencodeContext): SessionSummary[] {
  const rows = ctx.db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC`)
    .all() as unknown as SessionRow[];

  return rows.map((r) => rowToSummary(r, parseSessionData(ctx.db, r.id), ctx.subagentIndex.get(r.id)?.length ?? 0));
}

function resolveSessionRow(db: DatabaseSync, sessionId: string): SessionRow {
  const exact = db.prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE id = ?`).get(sessionId) as unknown as
    | SessionRow
    | undefined;
  if (exact) return exact;

  const matches = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE id LIKE ?`)
    .all(`${sessionId}%`) as unknown as SessionRow[];
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
  --user-dir, -u <dir> opencode data dir (default: ~/.local/share/opencode)
  --json               Machine-readable JSON output
  --sort <field>       list: date, tokens, duration, tools, cost
                       totals: date, tokens, tools, cost (default: date)
  --limit, -n <N>      Limit to N rows
  --group-by, -g <p>   totals period: day or week (default: day)
  --no-color           Disable ANSI colors
  -h, --help           Show this help

opencode records real costs in its session DB; the shared --no-cost and
--refresh-prices flags are no-ops for this tool.`;

const DEFAULT_DATA_DIR =
  process.env.XDG_DATA_HOME != null && process.env.XDG_DATA_HOME !== ''
    ? path.join(process.env.XDG_DATA_HOME, 'opencode')
    : '~/.local/share/opencode';

const adapter: SessionUsageAdapter<OpencodeContext> = {
  help: HELP,
  defaultUserDir: DEFAULT_DATA_DIR,
  resolveContext(args, userDir) {
    const db = openDb(userDir);
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
