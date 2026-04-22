#!/usr/bin/env node
// Codex CLI session log usage summarizer
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

interface ToolCounts {
  [name: string]: number;
}

interface SessionSummary {
  sessionId: string;
  filePath: string;
  model: string;
  cwd: string;
  cliVersion: string;
  isSubagent: boolean;
  parentId: string;
  agentNickname: string;
  agentRole: string;
  startTime: string;
  endTime: string;
  durationSecs: number;
  userTurns: number;
  tokens: TokenUsage;
  toolCalls: number;
  toolBreakdown: ToolCounts;
  subagentCount: number;
}

interface SubagentDetail {
  sessionId: string;
  agentNickname: string;
  agentRole: string;
  model: string;
  tokens: TokenUsage;
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
  json: boolean;
  sort: 'date' | 'tokens' | 'duration' | 'tools';
  limit: number;
  noColor: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODEX_DIR = path.join(process.env.HOME ?? '', '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');

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
  header: '\x1b[38;5;244m',
} as const;

const HELP = `Usage: session-usage.ts [command] [options]

Commands:
  list                 List all sessions (default)
  session <id>         Detailed single-session report

Options:
  --project, -p <path> Filter sessions by project directory
  --json               Machine-readable JSON output
  --sort <field>       Sort by: date, tokens, duration, tools (default: date)
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

// ---------------------------------------------------------------------------
// Arg Parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'list',
    sessionId: '',
    projectPath: '',
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
// Session Discovery
// ---------------------------------------------------------------------------

function findAllSessionFiles(): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  }

  walk(SESSIONS_DIR);
  return results;
}

// ---------------------------------------------------------------------------
// JSONL Parsing
// ---------------------------------------------------------------------------

function readJsonlLines(filePath: string): any[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const results: any[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Session Parsing
// ---------------------------------------------------------------------------

function parseSessionFile(filePath: string): SessionSummary {
  const entries = readJsonlLines(filePath);

  let sessionId = '';
  let model = '';
  let cwd = '';
  let cliVersion = '';
  let isSubagent = false;
  let parentId = '';
  let agentNickname = '';
  let agentRole = '';
  let startTime = '';
  let endTime = '';
  let userTurns = 0;
  let tokens: TokenUsage = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
  const toolBreakdown: ToolCounts = {};
  let toolCalls = 0;

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;

    if (entry.timestamp) {
      if (!startTime) startTime = entry.timestamp;
      endTime = entry.timestamp;
    }

    if (entry.type === 'session_meta' && !sessionId) {
      const p = entry.payload;
      sessionId = p?.id ?? '';
      cwd = p?.cwd ?? '';
      cliVersion = p?.cli_version ?? '';
      agentNickname = p?.agent_nickname ?? '';
      agentRole = p?.agent_role ?? '';
      if (typeof p?.source === 'object' && p.source?.subagent) {
        isSubagent = true;
        parentId = p.forked_from_id ?? '';
      } else {
        isSubagent = false;
        parentId = '';
      }
    }

    if (entry.type === 'turn_context' && !model) {
      model = entry.payload?.model ?? '';
    }

    if (entry.type === 'event_msg') {
      const p = entry.payload;
      if (p?.type === 'user_message') {
        userTurns++;
      }
      if (p?.type === 'token_count' && p.info?.total_token_usage) {
        const u = p.info.total_token_usage;
        tokens = {
          input: u.input_tokens ?? 0,
          cachedInput: u.cached_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          reasoning: u.reasoning_output_tokens ?? 0,
        };
      }
    }

    if (entry.type === 'response_item') {
      const p = entry.payload;
      if (p?.type === 'function_call' && p.name) {
        toolCalls++;
        toolBreakdown[p.name] = (toolBreakdown[p.name] ?? 0) + 1;
      }
      if (p?.type === 'custom_tool_call' && p.name) {
        toolCalls++;
        toolBreakdown[p.name] = (toolBreakdown[p.name] ?? 0) + 1;
      }
    }
  }

  if (!sessionId) {
    sessionId = path.basename(filePath, '.jsonl');
  }

  const startMs = startTime ? new Date(startTime).getTime() : 0;
  const endMs = endTime ? new Date(endTime).getTime() : 0;
  const durationSecs = startMs && endMs ? Math.max(0, Math.floor((endMs - startMs) / 1000)) : 0;

  // Count subagents by finding files that reference this session as parent
  let subagentCount = 0;
  if (!isSubagent) {
    subagentCount = countSubagents(sessionId);
  }

  return {
    sessionId,
    filePath,
    model,
    cwd,
    cliVersion,
    isSubagent,
    parentId,
    agentNickname,
    agentRole,
    startTime,
    endTime,
    durationSecs,
    userTurns,
    tokens,
    toolCalls,
    toolBreakdown,
    subagentCount,
  };
}

let subagentIndex: Map<string, string[]> | null = null;

function buildSubagentIndex(): Map<string, string[]> {
  if (subagentIndex) return subagentIndex;
  subagentIndex = new Map();
  const allFiles = findAllSessionFiles();
  for (const f of allFiles) {
    const first = fs.readFileSync(f, 'utf-8').split('\n')[0] ?? '';
    try {
      const entry = JSON.parse(first);
      if (entry.type === 'session_meta' && entry.payload?.forked_from_id) {
        const parentId = entry.payload.forked_from_id;
        const list = subagentIndex.get(parentId) ?? [];
        list.push(f);
        subagentIndex.set(parentId, list);
      }
    } catch {
      // skip
    }
  }
  return subagentIndex;
}

function countSubagents(sessionId: string): number {
  const idx = buildSubagentIndex();
  return idx.get(sessionId)?.length ?? 0;
}

function getSubagentFiles(sessionId: string): string[] {
  const idx = buildSubagentIndex();
  return idx.get(sessionId) ?? [];
}

function getSessionDetail(filePath: string): SessionDetail {
  const summary = parseSessionFile(filePath);
  const subagentFiles = getSubagentFiles(summary.sessionId);
  const subagents: SubagentDetail[] = subagentFiles.map((f) => {
    const sub = parseSessionFile(f);
    return {
      sessionId: sub.sessionId,
      agentNickname: sub.agentNickname,
      agentRole: sub.agentRole,
      model: sub.model,
      tokens: sub.tokens,
      toolCalls: sub.toolCalls,
      toolBreakdown: sub.toolBreakdown,
    };
  });
  return { ...summary, subagents };
}

// ---------------------------------------------------------------------------
// Sorting
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
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregateTotals(sessions: SessionSummary[]) {
  return sessions.reduce(
    (acc, s) => ({
      input: acc.input + s.tokens.input,
      cached: acc.cached + s.tokens.cachedInput,
      output: acc.output + s.tokens.output,
      reasoning: acc.reasoning + s.tokens.reasoning,
      tools: acc.tools + s.toolCalls,
      agents: acc.agents + s.subagentCount,
    }),
    { input: 0, cached: 0, output: 0, reasoning: 0, tools: 0, agents: 0 },
  );
}

// ---------------------------------------------------------------------------
// Human-Readable Output: Session Detail
// ---------------------------------------------------------------------------

function printSessionDetail(detail: SessionDetail): void {
  const w = (label: string, value: string) => console.log(`  ${c(COLORS.label, label.padEnd(28))} ${value}`);

  console.log(c(COLORS.bold, 'Session') + '  ' + c(COLORS.session, detail.sessionId));
  console.log(c(COLORS.bold, 'Model') + '    ' + c(COLORS.model, detail.model || '—'));
  if (detail.cwd) {
    console.log(c(COLORS.bold, 'CWD') + '      ' + c(COLORS.label, detail.cwd));
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
  console.log();

  console.log(c(COLORS.bold, 'Tokens'));
  w('Input', c(COLORS.input, fmtSi(detail.tokens.input)));
  w('Cached input', c(COLORS.cached, fmtSi(detail.tokens.cachedInput)));
  w('Output', c(COLORS.output, fmtSi(detail.tokens.output)));
  w('Reasoning', c(COLORS.reasoning, fmtSi(detail.tokens.reasoning)));
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
      const nickPart = sa.agentNickname ? c(COLORS.agents, sa.agentNickname) : c(COLORS.grey, 'unnamed');
      const rolePart = sa.agentRole ? c(COLORS.model, sa.agentRole) : '';
      console.log('  ' + nickPart + (rolePart ? '  ' + rolePart : '') + '  ' + c(COLORS.session, sa.model));
      const tokenStr = `${fmtSi(sa.tokens.input)} in / ${fmtSi(sa.tokens.cachedInput)} cached / ${fmtSi(sa.tokens.output)} out / ${fmtSi(sa.tokens.reasoning)} reasoning`;
      console.log(
        '    ' +
          c(COLORS.label, 'Tokens') +
          '  ' +
          tokenStr +
          '    ' +
          c(COLORS.label, 'Tools') +
          '  ' +
          c(COLORS.tools, String(sa.toolCalls)),
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
    session: 36,
    start: 11,
    dur: 9,
    turns: 5,
    model: 16,
    input: 8,
    cached: 8,
    output: 8,
    tools: 6,
    agents: 6,
  };

  const hdr =
    c(COLORS.header, 'SESSION'.padEnd(cols.session)) +
    '  ' +
    c(COLORS.header, 'START'.padEnd(cols.start)) +
    '  ' +
    c(COLORS.header, 'DURATION'.padStart(cols.dur)) +
    '  ' +
    c(COLORS.header, 'TURNS'.padStart(cols.turns)) +
    '  ' +
    c(COLORS.header, 'MODEL'.padEnd(cols.model)) +
    '  ' +
    c(COLORS.header, 'INPUT'.padStart(cols.input)) +
    '  ' +
    c(COLORS.header, 'CACHED'.padStart(cols.cached)) +
    '  ' +
    c(COLORS.header, 'OUTPUT'.padStart(cols.output)) +
    '  ' +
    c(COLORS.header, 'TOOLS'.padStart(cols.tools)) +
    '  ' +
    c(COLORS.header, 'AGENTS'.padStart(cols.agents));

  console.log(hdr);

  for (const s of sessions) {
    const row =
      c(COLORS.session, s.sessionId.padEnd(cols.session)) +
      '  ' +
      c(COLORS.time, fmtDate(s.startTime).padEnd(cols.start)) +
      '  ' +
      c(COLORS.time, fmtDuration(s.durationSecs).padStart(cols.dur)) +
      '  ' +
      c(COLORS.turns, String(s.userTurns).padStart(cols.turns)) +
      '  ' +
      c(COLORS.model, s.model.padEnd(cols.model)) +
      '  ' +
      c(COLORS.input, fmtSi(s.tokens.input).padStart(cols.input)) +
      '  ' +
      c(COLORS.cached, fmtSi(s.tokens.cachedInput).padStart(cols.cached)) +
      '  ' +
      c(COLORS.output, fmtSi(s.tokens.output).padStart(cols.output)) +
      '  ' +
      c(COLORS.tools, String(s.toolCalls).padStart(cols.tools)) +
      '  ' +
      c(COLORS.agents, String(s.subagentCount).padStart(cols.agents));
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
      c(COLORS.cached, fmtSi(totals.cached)) +
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
      c(COLORS.agents, String(totals.agents)),
  );
}

// ---------------------------------------------------------------------------
// JSON Output
// ---------------------------------------------------------------------------

function sessionSummaryToJson(s: SessionSummary): object {
  return {
    session_id: s.sessionId,
    model: s.model,
    cwd: s.cwd,
    cli_version: s.cliVersion,
    start: s.startTime,
    end: s.endTime,
    duration_seconds: s.durationSecs,
    user_turns: s.userTurns,
    tokens: {
      input: s.tokens.input,
      cached_input: s.tokens.cachedInput,
      output: s.tokens.output,
      reasoning: s.tokens.reasoning,
    },
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
      agent_nickname: sa.agentNickname,
      agent_role: sa.agentRole,
      model: sa.model,
      tokens: {
        input: sa.tokens.input,
        cached_input: sa.tokens.cachedInput,
        output: sa.tokens.output,
        reasoning: sa.tokens.reasoning,
      },
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
            cached_input: totals.cached,
            output: totals.output,
            reasoning: totals.reasoning,
          },
          tool_calls: totals.tools,
          subagents: totals.agents,
        },
        sessions: sessions.map(sessionSummaryToJson),
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Project Path Resolution
// ---------------------------------------------------------------------------

function resolveProjectPath(input: string): string {
  if (!input) {
    return process.cwd();
  }
  if (input.startsWith('~')) {
    return path.join(process.env.HOME ?? '', input.slice(1));
  }
  return path.resolve(input);
}

// ---------------------------------------------------------------------------
// Session ID resolution
// ---------------------------------------------------------------------------

function resolveSessionFile(sessionId: string): string {
  const allFiles = findAllSessionFiles();

  // Try exact match on session ID from session_meta
  for (const f of allFiles) {
    if (f.includes(sessionId)) return f;
  }

  // Try prefix match
  const matches = allFiles.filter((f) => {
    const first = fs.readFileSync(f, 'utf-8').split('\n')[0] ?? '';
    try {
      const entry = JSON.parse(first);
      if (entry.type === 'session_meta') {
        return (entry.payload?.id ?? '').startsWith(sessionId);
      }
    } catch {
      // skip
    }
    return false;
  });

  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    console.error(`Ambiguous session prefix "${sessionId}", matches:`);
    for (const f of matches) console.error(`  ${path.basename(f, '.jsonl')}`);
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

  if (!fs.existsSync(SESSIONS_DIR)) {
    console.error(`Codex sessions directory not found: ${SESSIONS_DIR}`);
    process.exit(1);
  }

  if (args.command === 'session') {
    const sessionFile = resolveSessionFile(args.sessionId);
    const detail = getSessionDetail(sessionFile);

    if (args.json) {
      console.log(JSON.stringify(sessionDetailToJson(detail), null, 2));
    } else {
      printSessionDetail(detail);
    }
    return;
  }

  // list command — only show parent sessions (not subagents)
  const allFiles = findAllSessionFiles();
  let sessions = allFiles.map(parseSessionFile).filter((s) => !s.isSubagent);

  const filterCwd = resolveProjectPath(args.projectPath);
  sessions = sessions.filter((s) => s.cwd === filterCwd || s.cwd.startsWith(filterCwd + '/'));

  sessions = sortSessions(sessions, args.sort);
  if (args.limit > 0) sessions = sessions.slice(0, args.limit);

  if (args.json) {
    printListJson(sessions);
  } else {
    printSessionTable(sessions);
  }
}

main();
