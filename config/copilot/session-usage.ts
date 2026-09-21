#!/usr/bin/env node
// GitHub Copilot CLI session usage summarizer
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { runSessionUsageCli, type SessionUsageAdapter } from '../../lib/node/ai-tooling/cli.ts';
import { resolveProjectPath } from '../../lib/node/ai-tooling/paths.ts';
import { makeSessionPreview } from '../../lib/node/ai-tooling/preview.ts';
import {
  type ModelTokenBreakdown,
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
  cwd: string | null;
  repository: string | null;
  host_type: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface TurnRow {
  user_message: string | null;
}

interface UsageRow {
  agent_id: string | null;
  parent_tool_call_id: string | null;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
}

interface ToolEventRow {
  tool_call_id: string;
  event_type: string;
  command: string | null;
  event_key: string | null;
  event_value: string | null;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface CopilotContext {
  db: DatabaseSync;
  filterCwd: string;
}

const SESSION_COLUMNS = 'id, cwd, repository, host_type, branch, summary, created_at, updated_at';

function openDb(userDir: string): DatabaseSync {
  const dbPath = path.join(userDir, 'session-store.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`GitHub Copilot session database not found: ${dbPath}`);
    process.exit(1);
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------

interface ParsedUsage {
  model: string;
  tokens: SessionTokens;
  modelBreakdown: ModelTokenBreakdown[];
  lastContextTokens?: number;
}

interface ParsedSession {
  usage: ParsedUsage;
  userTurns: number;
  preview: string;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  subagents: Subagent[];
}

function parseUsage(rows: UsageRow[], includeLastContext: boolean): ParsedUsage {
  const tokens: SessionTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const perModel = new Map<string, SessionTokens>();
  let lastContextTokens: number | undefined;

  for (const row of rows) {
    const input = row.input_tokens ?? 0;
    const output = row.output_tokens ?? 0;
    const cacheRead = row.cache_read_tokens ?? 0;
    const cacheWrite = row.cache_write_tokens ?? 0;
    const reasoning = row.reasoning_tokens ?? 0;
    tokens.input += input;
    tokens.output += output;
    tokens.cacheRead += cacheRead;
    tokens.cacheWrite = (tokens.cacheWrite ?? 0) + cacheWrite;
    tokens.reasoning = (tokens.reasoning ?? 0) + reasoning;

    const modelTokens = perModel.get(row.model) ?? {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
    };
    modelTokens.input += input;
    modelTokens.output += output;
    modelTokens.cacheRead += cacheRead;
    modelTokens.cacheWrite = (modelTokens.cacheWrite ?? 0) + cacheWrite;
    modelTokens.reasoning = (modelTokens.reasoning ?? 0) + reasoning;
    perModel.set(row.model, modelTokens);

    if (includeLastContext) {
      const contextTokens = input + cacheRead + cacheWrite;
      if (contextTokens > 0) lastContextTokens = contextTokens;
    }
  }

  const modelBreakdown: ModelTokenBreakdown[] = [];
  let model = '';
  let dominantOutput = -1;
  for (const [name, modelTokens] of perModel) {
    modelBreakdown.push({ model: name, tokens: modelTokens });
    if (modelTokens.output > dominantOutput) {
      model = name;
      dominantOutput = modelTokens.output;
    }
  }

  const parsed: ParsedUsage = { model, tokens, modelBreakdown };
  if (lastContextTokens !== undefined) parsed.lastContextTokens = lastContextTokens;
  return parsed;
}

function toolName(row: ToolEventRow): string {
  if ((row.event_key === 'tool_name' || row.event_key === 'toolName') && row.event_value) return row.event_value;
  if (row.command) return 'shell';
  return row.event_type || 'unknown';
}

function parseTools(
  db: DatabaseSync,
  sessionId: string,
): {
  toolCalls: number;
  toolBreakdown: Record<string, number>;
} {
  const rows = db
    .prepare(
      'SELECT tool_call_id, event_type, command, event_key, event_value FROM forge_trajectory_events WHERE session_id = ? AND tool_call_id IS NOT NULL ORDER BY id',
    )
    .all(sessionId) as unknown as ToolEventRow[];

  const calls = new Map<string, string>();
  for (const row of rows) {
    const name = toolName(row);
    const current = calls.get(row.tool_call_id);
    const isExplicitName = row.event_key === 'tool_name' || row.event_key === 'toolName';
    if (!current || isExplicitName) calls.set(row.tool_call_id, name);
  }

  const toolBreakdown: Record<string, number> = {};
  for (const name of calls.values()) toolBreakdown[name] = (toolBreakdown[name] ?? 0) + 1;
  return { toolCalls: calls.size, toolBreakdown };
}

function parseSubagents(rows: UsageRow[]): Subagent[] {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    if (!row.parent_tool_call_id) continue;
    const id = row.parent_tool_call_id;
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }

  const subagents: Subagent[] = [];
  for (const [id, group] of groups) {
    const parsed = parseUsage(group, false);
    const subagent: Subagent = {
      agentId: id,
      agentLabel: group[0]?.agent_id ?? 'subagent',
      model: parsed.model,
      tokens: parsed.tokens,
      toolCalls: 0,
      toolBreakdown: {},
    };
    if (parsed.modelBreakdown.length > 0) subagent.modelBreakdown = parsed.modelBreakdown;
    subagents.push(subagent);
  }
  return subagents;
}

function parseSession(db: DatabaseSync, sessionId: string): ParsedSession {
  const turns = db
    .prepare('SELECT user_message FROM turns WHERE session_id = ? ORDER BY turn_index')
    .all(sessionId) as unknown as TurnRow[];
  const usageRows = db
    .prepare(
      'SELECT agent_id, parent_tool_call_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM assistant_usage_events WHERE session_id = ? ORDER BY id',
    )
    .all(sessionId) as unknown as UsageRow[];
  const rootUsage = parseUsage(
    usageRows.filter((row) => !row.parent_tool_call_id),
    true,
  );
  const { toolCalls, toolBreakdown } = parseTools(db, sessionId);
  const firstUserMessage = turns.find((turn) => turn.user_message?.trim());

  return {
    usage: rootUsage,
    userTurns: turns.filter((turn) => turn.user_message != null).length,
    preview: makeSessionPreview(firstUserMessage?.user_message),
    toolCalls,
    toolBreakdown,
    subagents: parseSubagents(usageRows),
  };
}

function rowToSummary(row: SessionRow, parsed: ParsedSession): SessionSummary {
  const startTime = row.created_at ?? '';
  const endTime = row.updated_at ?? '';
  const startMs = startTime ? new Date(startTime).getTime() : 0;
  const endMs = endTime ? new Date(endTime).getTime() : 0;
  const summary: SessionSummary = {
    sessionId: row.id,
    model: parsed.usage.model,
    startTime,
    endTime,
    durationSecs: startMs && endMs ? Math.max(0, Math.floor((endMs - startMs) / 1000)) : 0,
    userTurns: parsed.userTurns,
    tokens: parsed.usage.tokens,
    toolCalls: parsed.toolCalls,
    toolBreakdown: parsed.toolBreakdown,
    subagentCount: parsed.subagents.length,
  };
  if (row.summary) summary.title = row.summary;
  if (parsed.preview) summary.preview = parsed.preview;
  if (row.cwd) summary.directory = row.cwd;
  if (parsed.usage.modelBreakdown.length > 0) summary.modelBreakdown = parsed.usage.modelBreakdown;
  if (parsed.usage.lastContextTokens !== undefined) summary.lastContextTokens = parsed.usage.lastContextTokens;
  return summary;
}

// ---------------------------------------------------------------------------
// Adapter operations
// ---------------------------------------------------------------------------

function listRows(db: DatabaseSync): SessionRow[] {
  return db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC`)
    .all() as unknown as SessionRow[];
}

function matchesFilter(cwd: string | null, filterCwd: string): boolean {
  if (!cwd) return false;
  return cwd === filterCwd || cwd.startsWith(`${filterCwd}${path.sep}`);
}

function listSessions(ctx: CopilotContext): SessionSummary[] {
  return listRows(ctx.db)
    .filter((row) => matchesFilter(row.cwd, ctx.filterCwd))
    .map((row) => rowToSummary(row, parseSession(ctx.db, row.id)));
}

function listAllSessions(ctx: CopilotContext): SessionSummary[] {
  return listRows(ctx.db).map((row) => rowToSummary(row, parseSession(ctx.db, row.id)));
}

function resolveSessionRow(db: DatabaseSync, sessionId: string): SessionRow {
  const exact = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId) as unknown as
    | SessionRow
    | undefined;
  if (exact) return exact;

  const matches = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id LIKE ?`)
    .all(`${sessionId}%`) as unknown as SessionRow[];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`Ambiguous session prefix "${sessionId}", matches:`);
    for (const row of matches) console.error(`  ${row.id}`);
    process.exit(1);
  }

  console.error(`Session not found: ${sessionId}`);
  process.exit(1);
}

function loadSessionDetail(ctx: CopilotContext, sessionId: string): SessionDetail {
  const row = resolveSessionRow(ctx.db, sessionId);
  const parsed = parseSession(ctx.db, row.id);
  return { ...rowToSummary(row, parsed), subagents: parsed.subagents };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `Usage: session-usage.ts [command] [options]

Commands:
  list                 List all sessions for the current project (default)
  session <uuid>       Detailed single-session report
  totals               Usage totals bucketed by day or week. Aggregates across
                       all projects unless --project is given.

Options:
  --project, -p <path> Filter sessions by project directory (default: $PWD)
  --user-dir, -u <dir> GitHub Copilot data dir (default: ~/.copilot)
  --json               Machine-readable JSON output
  --sort <field>       list: date, tokens, duration, tools
                       totals: date, tokens, tools (default: date)
  --limit, -n <N>      Limit to N rows
  --group-by, -g <p>   totals period: day or week (default: day)
  --no-color           Disable ANSI colors
  -h, --help           Show this help

GitHub Copilot records token usage in session-store.db but does not record
USD costs. --no-cost and --refresh-prices are accepted for interface parity
with the other tools but have no effect here.`;

const adapter: SessionUsageAdapter<CopilotContext> = {
  help: HELP,
  defaultUserDir: '~/.copilot',
  sessionArgLabel: '<uuid>',
  resolveContext(args, userDir) {
    return {
      db: openDb(userDir),
      filterCwd: resolveProjectPath(args.projectArg),
    };
  },
  listSessions,
  listAllSessions,
  loadSessionDetail,
};

runSessionUsageCli(adapter).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
