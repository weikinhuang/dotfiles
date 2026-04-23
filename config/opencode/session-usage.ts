#!/usr/bin/env node
// opencode session log usage summarizer
// SPDX-License-Identifier: MIT

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  reasoning: number;
}

interface ToolCounts {
  [name: string]: number;
}

interface SessionSummary {
  sessionId: string;
  parentId: string;
  isSubagent: boolean;
  title: string;
  slug: string;
  directory: string;
  version: string;
  agent: string;
  model: string;
  startTime: string;
  endTime: string;
  durationSecs: number;
  userTurns: number;
  tokens: TokenUsage;
  cost: number;
  toolCalls: number;
  toolBreakdown: ToolCounts;
  subagentCount: number;
}

interface SubagentDetail {
  sessionId: string;
  title: string;
  agent: string;
  model: string;
  tokens: TokenUsage;
  cost: number;
  toolCalls: number;
  toolBreakdown: ToolCounts;
}

interface SessionDetail extends SessionSummary {
  subagents: SubagentDetail[];
}

interface ParsedArgs {
  command: 'list' | 'session';
  sessionId: string;
  projectPath: string;
  userDir: string;
  json: boolean;
  sort: 'date' | 'tokens' | 'duration' | 'tools' | 'cost';
  limit: number;
  noColor: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OPENCODE_DIR = path.join(
  process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? '', '.local', 'share'),
  'opencode',
);

let DATA_DIR = DEFAULT_OPENCODE_DIR;

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  grey: '\x1b[38;5;244m',
  label: '\x1b[38;5;245m',
  session: '\x1b[38;5;033m',
  model: '\x1b[38;5;135m',
  time: '\x1b[38;5;142m',
  turns: '\x1b[38;5;179m',
  input: '\x1b[38;5;197m',
  cached: '\x1b[38;5;108m',
  output: '\x1b[38;5;214m',
  reasoning: '\x1b[38;5;173m',
  tools: '\x1b[38;5;173m',
  agents: '\x1b[38;5;109m',
  cost: '\x1b[38;5;220m',
  header: '\x1b[38;5;244m',
} as const;

const HELP = `Usage: session-usage.ts [command] [options]

Commands:
  list                 List all sessions (default)
  session <id>         Detailed single-session report

Options:
  --project, -p <path> Filter sessions by project directory (default: $PWD)
  --user-dir, -u <dir> opencode data dir (default: ~/.local/share/opencode)
  --json               Machine-readable JSON output
  --sort <field>       Sort by: date, tokens, duration, tools, cost (default: date)
  --limit, -n <N>      Limit to N sessions
  --no-color           Disable ANSI colors
  -h, --help           Show this help`;

let useColor = true;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function c(code: string, text: string): string {
  if (!useColor) return text;
  return `${code}${text}${COLORS.reset}`;
}

function fmtSi(n: number): string {
  if (n >= 1_000_000) {
    const whole = Math.floor(n / 1_000_000);
    let frac = Math.round(((n % 1_000_000) * 100) / 1_000_000);
    if (frac === 100) return `${whole + 1}.00M`;
    return `${whole}.${String(frac).padStart(2, '0')}M`;
  }
  if (n >= 1_000) return `${Math.floor(n / 1_000)}k`;
  return String(n);
}

function fmtDuration(secs: number): string {
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  return `${secs}s`;
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

function fmtDateFull(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mm}-${dd} ${hh}:${min}`;
}

function fmtNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtCost(cost: number): string {
  if (cost <= 0) return '$0';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

function padEndVisible(s: string, width: number): string {
  if (s.length >= width) return truncate(s, width);
  return s + ' '.repeat(width - s.length);
}

// ---------------------------------------------------------------------------
// Arg Parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'list',
    sessionId: '',
    projectPath: '',
    userDir: '',
    json: false,
    sort: 'date',
    limit: 0,
    noColor: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
      case '--json':
        args.json = true;
        break;
      case '--no-color':
        args.noColor = true;
        break;
      case '--project':
      case '-p':
        i++;
        args.projectPath = argv[i] ?? '';
        break;
      case '--user-dir':
      case '-u':
        i++;
        args.userDir = argv[i] ?? '';
        break;
      case '--sort':
        i++;
        args.sort = (argv[i] ?? 'date') as ParsedArgs['sort'];
        break;
      case '--limit':
      case '-n':
        i++;
        args.limit = parseInt(argv[i] ?? '0', 10);
        break;
      default:
        if (arg.startsWith('--project=')) {
          args.projectPath = arg.slice('--project='.length);
        } else if (arg.startsWith('--user-dir=')) {
          args.userDir = arg.slice('--user-dir='.length);
        } else if (arg.startsWith('--sort=')) {
          args.sort = arg.slice('--sort='.length) as ParsedArgs['sort'];
        } else if (arg.startsWith('--limit=')) {
          args.limit = parseInt(arg.slice('--limit='.length), 10);
        } else if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        } else if (arg === 'session') {
          args.command = 'session';
          i++;
          args.sessionId = argv[i] ?? '';
          if (!args.sessionId) {
            console.error('session command requires an <id> argument');
            process.exit(1);
          }
        } else if (arg === 'list') {
          args.command = 'list';
        } else {
          console.error(`Unknown argument: ${arg}`);
          process.exit(1);
        }
        break;
    }
    i++;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

function expandUserPath(p: string): string {
  if (p.startsWith('~')) return path.join(process.env.HOME ?? '', p.slice(1));
  return path.resolve(p);
}

function resolveProjectPath(input: string): string {
  if (!input) return process.cwd();
  return expandUserPath(input);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function openDb(): DatabaseSync {
  const dbPath = path.join(DATA_DIR, 'opencode.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`opencode database not found: ${dbPath}`);
    process.exit(1);
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

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
  session_id: string;
  time_created: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  data: string;
}

// ---------------------------------------------------------------------------
// Session Parsing
// ---------------------------------------------------------------------------

function emptyTokens(): TokenUsage {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 };
}

function parseSession(db: DatabaseSync, row: SessionRow, subagentCount: number): SessionSummary {
  const messages = db
    .prepare('SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created')
    .all(row.id) as unknown as MessageRow[];

  let userTurns = 0;
  let model = '';
  let agent = '';
  let cost = 0;
  const tokens = emptyTokens();

  const assistantMessageIds: string[] = [];

  for (const m of messages) {
    let d: any;
    try {
      d = JSON.parse(m.data);
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
      const t = d.tokens ?? {};
      tokens.input += t.input ?? 0;
      tokens.output += t.output ?? 0;
      tokens.reasoning += t.reasoning ?? 0;
      tokens.cacheWrite += t.cache?.write ?? 0;
      tokens.cacheRead += t.cache?.read ?? 0;
    }
  }

  const toolBreakdown: ToolCounts = {};
  let toolCalls = 0;

  if (assistantMessageIds.length > 0) {
    const placeholders = assistantMessageIds.map(() => '?').join(',');
    const parts = db
      .prepare(`SELECT id, message_id, data FROM part WHERE message_id IN (${placeholders})`)
      .all(...assistantMessageIds) as unknown as PartRow[];
    for (const p of parts) {
      let d: any;
      try {
        d = JSON.parse(p.data);
      } catch {
        continue;
      }
      if (d.type === 'tool' && typeof d.tool === 'string') {
        toolCalls++;
        toolBreakdown[d.tool] = (toolBreakdown[d.tool] ?? 0) + 1;
      }
    }
  }

  const startMs = row.time_created;
  const endMs = row.time_updated;
  const durationSecs = startMs && endMs ? Math.max(0, Math.floor((endMs - startMs) / 1000)) : 0;

  return {
    sessionId: row.id,
    parentId: row.parent_id ?? '',
    isSubagent: !!row.parent_id,
    title: row.title,
    slug: row.slug,
    directory: row.directory,
    version: row.version,
    agent,
    model,
    startTime: startMs ? new Date(startMs).toISOString() : '',
    endTime: endMs ? new Date(endMs).toISOString() : '',
    durationSecs,
    userTurns,
    tokens,
    cost,
    toolCalls,
    toolBreakdown,
    subagentCount,
  };
}

function buildSubagentIndex(db: DatabaseSync): Map<string, SessionRow[]> {
  const index = new Map<string, SessionRow[]>();
  const rows = db
    .prepare(
      'SELECT id, parent_id, slug, directory, title, version, time_created, time_updated FROM session WHERE parent_id IS NOT NULL',
    )
    .all() as unknown as SessionRow[];
  for (const r of rows) {
    if (!r.parent_id) continue;
    const list = index.get(r.parent_id) ?? [];
    list.push(r);
    index.set(r.parent_id, list);
  }
  return index;
}

function getSessionDetail(db: DatabaseSync, row: SessionRow, subagentRows: SessionRow[]): SessionDetail {
  const summary = parseSession(db, row, subagentRows.length);
  const subagents: SubagentDetail[] = subagentRows.map((sr) => {
    const s = parseSession(db, sr, 0);
    return {
      sessionId: s.sessionId,
      title: s.title,
      agent: s.agent,
      model: s.model,
      tokens: s.tokens,
      cost: s.cost,
      toolCalls: s.toolCalls,
      toolBreakdown: s.toolBreakdown,
    };
  });
  return { ...summary, subagents };
}

// ---------------------------------------------------------------------------
// Sorting & Aggregation
// ---------------------------------------------------------------------------

function sortSessions(sessions: SessionSummary[], field: ParsedArgs['sort']): SessionSummary[] {
  const sorted = [...sessions];
  switch (field) {
    case 'date':
      sorted.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
      break;
    case 'tokens':
      sorted.sort((a, b) => {
        const at = a.tokens.input + a.tokens.output;
        const bt = b.tokens.input + b.tokens.output;
        return bt - at;
      });
      break;
    case 'duration':
      sorted.sort((a, b) => b.durationSecs - a.durationSecs);
      break;
    case 'tools':
      sorted.sort((a, b) => b.toolCalls - a.toolCalls);
      break;
    case 'cost':
      sorted.sort((a, b) => b.cost - a.cost);
      break;
  }
  return sorted;
}

function aggregateTotals(sessions: SessionSummary[]) {
  return sessions.reduce(
    (acc, s) => ({
      input: acc.input + s.tokens.input,
      cacheWrite: acc.cacheWrite + s.tokens.cacheWrite,
      cacheRead: acc.cacheRead + s.tokens.cacheRead,
      output: acc.output + s.tokens.output,
      reasoning: acc.reasoning + s.tokens.reasoning,
      tools: acc.tools + s.toolCalls,
      agents: acc.agents + s.subagentCount,
      cost: acc.cost + s.cost,
    }),
    { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, tools: 0, agents: 0, cost: 0 },
  );
}

// ---------------------------------------------------------------------------
// Human-Readable Output: Session Detail
// ---------------------------------------------------------------------------

function printSessionDetail(detail: SessionDetail): void {
  const w = (label: string, value: string) => console.log(`  ${c(COLORS.label, label.padEnd(28))} ${value}`);

  console.log(c(COLORS.bold, 'Session') + '  ' + c(COLORS.session, detail.sessionId));
  if (detail.title) {
    console.log(c(COLORS.bold, 'Title') + '    ' + c(COLORS.label, detail.title));
  }
  console.log(
    c(COLORS.bold, 'Model') +
      '    ' +
      c(COLORS.model, detail.model || '—') +
      (detail.agent ? '  ' + c(COLORS.agents, `(${detail.agent})`) : ''),
  );
  if (detail.directory) {
    console.log(c(COLORS.bold, 'CWD') + '      ' + c(COLORS.label, detail.directory));
  }
  console.log(
    c(COLORS.bold, 'Start') +
      '    ' +
      c(COLORS.time, fmtDateFull(detail.startTime)) +
      '    ' +
      c(COLORS.bold, 'Duration') +
      '  ' +
      c(COLORS.time, fmtDuration(detail.durationSecs)),
  );
  console.log(c(COLORS.bold, 'Turns') + '    ' + c(COLORS.turns, `${detail.userTurns} user prompts`));
  if (detail.version) {
    console.log(c(COLORS.bold, 'Version') + '  ' + c(COLORS.label, detail.version));
  }
  console.log();

  console.log(c(COLORS.bold, 'Tokens'));
  w('Input', c(COLORS.input, fmtSi(detail.tokens.input)));
  w('Cache write', c(COLORS.cached, fmtSi(detail.tokens.cacheWrite)));
  w('Cache read', c(COLORS.cached, fmtSi(detail.tokens.cacheRead)));
  w('Output', c(COLORS.output, fmtSi(detail.tokens.output)));
  w('Reasoning', c(COLORS.reasoning, fmtSi(detail.tokens.reasoning)));
  if (detail.cost > 0) {
    w('Cost', c(COLORS.cost, fmtCost(detail.cost)));
  }
  console.log();

  console.log(c(COLORS.bold, 'Tools') + '    ' + c(COLORS.tools, `${fmtNumber(detail.toolCalls)} calls`));
  const sortedTools = Object.entries(detail.toolBreakdown).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sortedTools) {
    console.log('  ' + c(COLORS.tools, String(count).padStart(6)) + '  ' + c(COLORS.label, name));
  }
  console.log();

  if (detail.subagents.length > 0) {
    console.log(c(COLORS.bold, 'Subagents') + ` (${c(COLORS.agents, String(detail.subagents.length))})`);
    for (const sa of detail.subagents) {
      const titlePart = sa.title ? c(COLORS.label, `"${sa.title}"`) : c(COLORS.grey, 'untitled');
      const agentPart = sa.agent ? c(COLORS.agents, sa.agent) : '';
      console.log(
        '  ' +
          c(COLORS.session, sa.sessionId) +
          (agentPart ? '  ' + agentPart : '') +
          '  ' +
          titlePart +
          (sa.model ? '  ' + c(COLORS.model, sa.model) : ''),
      );
      const tokenStr = `${fmtSi(sa.tokens.input)} in / ${fmtSi(sa.tokens.cacheRead)} cached / ${fmtSi(
        sa.tokens.output,
      )} out / ${fmtSi(sa.tokens.reasoning)} reasoning`;
      console.log(
        '    ' +
          c(COLORS.label, 'Tokens') +
          '  ' +
          tokenStr +
          '    ' +
          c(COLORS.label, 'Tools') +
          '  ' +
          c(COLORS.tools, String(sa.toolCalls)) +
          (sa.cost > 0 ? '    ' + c(COLORS.label, 'Cost') + '  ' + c(COLORS.cost, fmtCost(sa.cost)) : ''),
      );
      const saTools = Object.entries(sa.toolBreakdown)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}:${count}`)
        .join(' ');
      if (saTools) {
        console.log('    ' + c(COLORS.grey, saTools));
      }
    }
  } else {
    console.log(c(COLORS.bold, 'Subagents') + '  none');
  }
}

// ---------------------------------------------------------------------------
// Human-Readable Output: Session List
// ---------------------------------------------------------------------------

function printSessionTable(sessions: SessionSummary[]): void {
  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  const dates = sessions
    .map((s) => s.startTime)
    .filter(Boolean)
    .sort();
  const rangeStart = dates[0] ? fmtDateFull(dates[0]!).slice(0, 10) : '—';
  const rangeEnd = dates.length > 0 ? fmtDateFull(dates[dates.length - 1]!).slice(0, 10) : '—';

  console.log(
    c(COLORS.bold, 'Sessions') +
      ' ' +
      c(COLORS.turns, String(sessions.length)) +
      '    ' +
      c(COLORS.bold, 'Range') +
      '  ' +
      c(COLORS.time, `${rangeStart} — ${rangeEnd}`),
  );
  console.log();

  const cols = {
    session: 30,
    title: 28,
    start: 11,
    dur: 9,
    turns: 5,
    input: 8,
    cached: 8,
    output: 8,
    tools: 6,
    agents: 6,
    cost: 8,
  };

  const hdr =
    c(COLORS.header, 'SESSION'.padEnd(cols.session)) +
    '  ' +
    c(COLORS.header, 'TITLE'.padEnd(cols.title)) +
    '  ' +
    c(COLORS.header, 'START'.padEnd(cols.start)) +
    '  ' +
    c(COLORS.header, 'DURATION'.padStart(cols.dur)) +
    '  ' +
    c(COLORS.header, 'TURNS'.padStart(cols.turns)) +
    '  ' +
    c(COLORS.header, 'INPUT'.padStart(cols.input)) +
    '  ' +
    c(COLORS.header, 'CACHED'.padStart(cols.cached)) +
    '  ' +
    c(COLORS.header, 'OUTPUT'.padStart(cols.output)) +
    '  ' +
    c(COLORS.header, 'TOOLS'.padStart(cols.tools)) +
    '  ' +
    c(COLORS.header, 'AGENTS'.padStart(cols.agents)) +
    '  ' +
    c(COLORS.header, 'COST'.padStart(cols.cost));

  console.log(hdr);

  for (const s of sessions) {
    const row =
      c(COLORS.session, s.sessionId.padEnd(cols.session)) +
      '  ' +
      c(COLORS.label, padEndVisible(s.title, cols.title)) +
      '  ' +
      c(COLORS.time, fmtDate(s.startTime).padEnd(cols.start)) +
      '  ' +
      c(COLORS.time, fmtDuration(s.durationSecs).padStart(cols.dur)) +
      '  ' +
      c(COLORS.turns, String(s.userTurns).padStart(cols.turns)) +
      '  ' +
      c(COLORS.input, fmtSi(s.tokens.input).padStart(cols.input)) +
      '  ' +
      c(COLORS.cached, fmtSi(s.tokens.cacheRead).padStart(cols.cached)) +
      '  ' +
      c(COLORS.output, fmtSi(s.tokens.output).padStart(cols.output)) +
      '  ' +
      c(COLORS.tools, String(s.toolCalls).padStart(cols.tools)) +
      '  ' +
      c(COLORS.agents, String(s.subagentCount).padStart(cols.agents)) +
      '  ' +
      c(COLORS.cost, fmtCost(s.cost).padStart(cols.cost));
    console.log(row);
  }

  const totals = aggregateTotals(sessions);

  console.log();
  console.log(
    c(COLORS.bold, 'Totals') +
      '    ' +
      c(COLORS.label, 'Input') +
      '  ' +
      c(COLORS.input, fmtSi(totals.input)) +
      '    ' +
      c(COLORS.label, 'Cached') +
      '  ' +
      c(COLORS.cached, fmtSi(totals.cacheRead)) +
      '    ' +
      c(COLORS.label, 'Output') +
      '  ' +
      c(COLORS.output, fmtSi(totals.output)) +
      '    ' +
      c(COLORS.label, 'Reasoning') +
      '  ' +
      c(COLORS.reasoning, fmtSi(totals.reasoning)) +
      '    ' +
      c(COLORS.label, 'Tools') +
      '  ' +
      c(COLORS.tools, fmtNumber(totals.tools)) +
      '    ' +
      c(COLORS.label, 'Agents') +
      '  ' +
      c(COLORS.agents, String(totals.agents)) +
      '    ' +
      c(COLORS.label, 'Cost') +
      '  ' +
      c(COLORS.cost, fmtCost(totals.cost)),
  );
}

// ---------------------------------------------------------------------------
// JSON Output
// ---------------------------------------------------------------------------

function tokensToJson(t: TokenUsage) {
  return {
    input: t.input,
    cache_write: t.cacheWrite,
    cache_read: t.cacheRead,
    output: t.output,
    reasoning: t.reasoning,
  };
}

function sessionSummaryToJson(s: SessionSummary): object {
  return {
    session_id: s.sessionId,
    parent_id: s.parentId || null,
    is_subagent: s.isSubagent,
    title: s.title,
    slug: s.slug,
    directory: s.directory,
    version: s.version,
    agent: s.agent,
    model: s.model,
    start: s.startTime,
    end: s.endTime,
    duration_seconds: s.durationSecs,
    user_turns: s.userTurns,
    tokens: tokensToJson(s.tokens),
    cost: s.cost,
    tool_calls: s.toolCalls,
    tool_breakdown: s.toolBreakdown,
    subagent_count: s.subagentCount,
  };
}

function sessionDetailToJson(d: SessionDetail): object {
  return {
    ...sessionSummaryToJson(d),
    subagents: d.subagents.map((sa) => ({
      session_id: sa.sessionId,
      title: sa.title,
      agent: sa.agent,
      model: sa.model,
      tokens: tokensToJson(sa.tokens),
      cost: sa.cost,
      tool_calls: sa.toolCalls,
      tool_breakdown: sa.toolBreakdown,
    })),
  };
}

function printListJson(sessions: SessionSummary[]): void {
  const totals = aggregateTotals(sessions);

  console.log(
    JSON.stringify(
      {
        session_count: sessions.length,
        totals: {
          tokens: {
            input: totals.input,
            cache_write: totals.cacheWrite,
            cache_read: totals.cacheRead,
            output: totals.output,
            reasoning: totals.reasoning,
          },
          tool_calls: totals.tools,
          subagents: totals.agents,
          cost: totals.cost,
        },
        sessions: sessions.map(sessionSummaryToJson),
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Session ID resolution
// ---------------------------------------------------------------------------

function resolveSessionRow(db: DatabaseSync, sessionId: string): SessionRow {
  const exact = db
    .prepare(
      'SELECT id, parent_id, slug, directory, title, version, time_created, time_updated FROM session WHERE id = ?',
    )
    .get(sessionId) as unknown as SessionRow | undefined;
  if (exact) return exact;

  const like = `${sessionId}%`;
  const matches = db
    .prepare(
      'SELECT id, parent_id, slug, directory, title, version, time_created, time_updated FROM session WHERE id LIKE ?',
    )
    .all(like) as unknown as SessionRow[];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    console.error(`Ambiguous session prefix "${sessionId}", matches:`);
    for (const r of matches) console.error(`  ${r.id}`);
    process.exit(1);
  }

  console.error(`Session not found: ${sessionId}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  useColor = !args.noColor && !args.json && process.stdout.isTTY !== false;

  DATA_DIR = args.userDir ? expandUserPath(args.userDir) : DEFAULT_OPENCODE_DIR;

  const db = openDb();

  if (args.command === 'session') {
    const row = resolveSessionRow(db, args.sessionId);
    const subIndex = buildSubagentIndex(db);
    const subagentRows = subIndex.get(row.id) ?? [];
    const detail = getSessionDetail(db, row, subagentRows);

    if (args.json) {
      console.log(JSON.stringify(sessionDetailToJson(detail), null, 2));
    } else {
      printSessionDetail(detail);
    }
    return;
  }

  // list command — only show parent sessions (not subagents)
  const filterCwd = resolveProjectPath(args.projectPath);
  const parentRows = db
    .prepare(
      'SELECT id, parent_id, slug, directory, title, version, time_created, time_updated FROM session WHERE parent_id IS NULL AND (directory = ? OR directory LIKE ?) ORDER BY time_updated DESC',
    )
    .all(filterCwd, `${filterCwd}/%`) as unknown as SessionRow[];

  const subIndex = buildSubagentIndex(db);
  let sessions = parentRows.map((r) => parseSession(db, r, subIndex.get(r.id)?.length ?? 0));

  sessions = sortSessions(sessions, args.sort);
  if (args.limit > 0) sessions = sessions.slice(0, args.limit);

  if (args.json) {
    printListJson(sessions);
  } else {
    printSessionTable(sessions);
  }
}

main();
