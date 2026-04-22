#!/usr/bin/env node
// Claude Code session log usage summarizer
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenUsage {
  input: number;
  cacheRead: number;
  output: number;
}

interface ToolCounts {
  [name: string]: number;
}

interface SessionSummary {
  sessionId: string;
  model: string;
  startTime: string;
  endTime: string;
  durationSecs: number;
  userTurns: number;
  tokens: TokenUsage;
  toolCalls: number;
  toolBytes: number;
  toolBreakdown: ToolCounts;
  skills: string[];

  subagentCount: number;
}

interface SubagentDetail {
  agentId: string;
  agentType: string;
  description: string;
  model: string;
  tokens: TokenUsage;
  toolCalls: number;
  toolBytes: number;
  toolBreakdown: ToolCounts;
  skills: string[];
}

interface SessionDetail extends SessionSummary {
  subagents: SubagentDetail[];
}

interface ParsedArgs {
  command: 'list' | 'session';
  sessionId: string;
  projectSlug: string;
  json: boolean;
  sort: 'date' | 'tokens' | 'duration' | 'tools';
  limit: number;
  noColor: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_DIR = path.join(process.env.HOME ?? '', '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

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
  tools: '\x1b[38;5;173m',
  agents: '\x1b[38;5;109m',
  header: '\x1b[38;5;244m',
  totals: '\x1b[38;5;179m',
} as const;

const HELP = `Usage: session-usage.ts [command] [options]

Commands:
  list                 List all sessions in a project (default)
  session <uuid>       Detailed single-session report

Options:
  --project, -p <slug> Project slug (default: derived from $PWD)
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
    projectSlug: '',
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
        args.projectSlug = argv[i] ?? '';
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
          args.projectSlug = arg.slice('--project='.length);
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
            console.error('session command requires a <uuid> argument');
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
// Project Discovery
// ---------------------------------------------------------------------------

function cwdToSlug(dir: string): string {
  return dir.replace(/[/.]/g, '-');
}

function detectProjectSlug(cwd: string): string {
  let dir = cwd;
  while (dir !== '/') {
    const slug = cwdToSlug(dir);
    if (fs.existsSync(path.join(PROJECTS_DIR, slug))) return slug;
    dir = path.dirname(dir);
  }
  return '';
}

function resolveProjectDir(args: ParsedArgs): string {
  let slug = args.projectSlug;
  if (slug && (slug.startsWith('/') || slug.startsWith('~') || slug.startsWith('.'))) {
    const resolved = slug.startsWith('~') ? path.join(process.env.HOME ?? '', slug.slice(1)) : path.resolve(slug);
    slug = detectProjectSlug(resolved);
  }
  if (!slug) {
    slug = detectProjectSlug(process.cwd());
  }
  if (!slug) {
    console.error('Could not detect project from $PWD. Use --project <slug> to specify one.');
    const projects = listProjects();
    if (projects.length > 0) {
      console.error('\nAvailable projects:');
      for (const p of projects) console.error(`  ${p}`);
    }
    process.exit(1);
  }
  const dir = path.join(PROJECTS_DIR, slug);
  if (!fs.existsSync(dir)) {
    console.error(`Project directory not found: ${dir}`);
    process.exit(1);
  }
  return dir;
}

function listProjects(): string[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function listSessionFiles(projectDir: string): string[] {
  return fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(projectDir, f));
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
      // skip malformed lines
    }
  }
  return results;
}

interface ParsedEntries {
  startTime: string;
  endTime: string;
  model: string;
  tokens: TokenUsage;
  toolCalls: number;
  toolBytes: number;
  toolBreakdown: ToolCounts;
  skills: string[];

  userTurns: number;
}

function parseEntries(entries: any[]): ParsedEntries {
  let input = 0;
  let cacheRead = 0;
  let output = 0;
  let toolCalls = 0;
  let toolBytes = 0;
  let userTurns = 0;
  let startTime = '';
  let endTime = '';
  let model = '';
  const toolBreakdown: ToolCounts = {};
  const skillCandidates = new Map<string, string>();
  const failedToolUseIds = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;

    if (entry.timestamp) {
      if (!startTime) startTime = entry.timestamp;
      endTime = entry.timestamp;
    }

    if (entry.type === 'assistant') {
      if (!model && entry.message?.model) {
        model = entry.message.model;
      }
      if (entry.message?.usage) {
        const u = entry.message.usage;
        input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        cacheRead += u.cache_read_input_tokens ?? 0;
        output += u.output_tokens ?? 0;
      }

      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use') {
            toolCalls++;
            const name: string = block.name ?? 'unknown';
            toolBreakdown[name] = (toolBreakdown[name] ?? 0) + 1;
            if (name === 'Skill' && typeof block.input?.skill === 'string') {
              skillCandidates.set(block.id, block.input.skill);
            }
          }
        }
      }
    }

    if (entry.type === 'user') {
      const content = entry.message?.content;
      if (typeof content === 'string') {
        if (!content.startsWith('<system-reminder>') && !content.startsWith('<local-command-')) {
          userTurns++;
        }
      }

      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block?.type === 'tool_result') {
            if (block.is_error) {
              failedToolUseIds.add(block.tool_use_id);
            }
            const rc = block.content;
            if (typeof rc === 'string') {
              toolBytes += rc.length;
            } else if (Array.isArray(rc)) {
              for (const item of rc) {
                if (typeof item === 'object' && typeof item?.text === 'string') {
                  toolBytes += item.text.length;
                }
              }
            }
          }
        }
      }
    }
  }

  const skills: string[] = [];
  for (const [toolUseId, skillName] of skillCandidates) {
    if (!failedToolUseIds.has(toolUseId)) {
      skills.push(skillName);
    }
  }

  return {
    startTime,
    endTime,
    model,
    tokens: { input, cacheRead, output },
    toolCalls,
    toolBytes,
    toolBreakdown,
    skills: [...new Set(skills)].sort(),
    userTurns,
  };
}

// ---------------------------------------------------------------------------
// Session Parsing
// ---------------------------------------------------------------------------

function parseSessionFile(filePath: string): SessionSummary {
  const sessionId = path.basename(filePath, '.jsonl');
  const entries = readJsonlLines(filePath);
  const parsed = parseEntries(entries);

  const startMs = parsed.startTime ? new Date(parsed.startTime).getTime() : 0;
  const endMs = parsed.endTime ? new Date(parsed.endTime).getTime() : 0;
  const durationSecs = startMs && endMs ? Math.max(0, Math.floor((endMs - startMs) / 1000)) : 0;

  // Count subagents
  const sessionDir = filePath.replace(/\.jsonl$/, '');
  const subagentDir = path.join(sessionDir, 'subagents');
  let subagentCount = 0;
  if (fs.existsSync(subagentDir)) {
    subagentCount = fs.readdirSync(subagentDir).filter((f) => f.endsWith('.jsonl')).length;
  }

  return {
    sessionId,
    model: parsed.model,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    durationSecs,
    userTurns: parsed.userTurns,
    tokens: parsed.tokens,
    toolCalls: parsed.toolCalls,
    toolBytes: parsed.toolBytes,
    toolBreakdown: parsed.toolBreakdown,
    skills: parsed.skills,
    subagentCount,
  };
}

function parseSubagentDetails(sessionFilePath: string): SubagentDetail[] {
  const sessionDir = sessionFilePath.replace(/\.jsonl$/, '');
  const subagentDir = path.join(sessionDir, 'subagents');
  if (!fs.existsSync(subagentDir)) return [];

  const jsonlFiles = fs.readdirSync(subagentDir).filter((f) => f.endsWith('.jsonl'));

  const details: SubagentDetail[] = [];

  for (const jsonlFile of jsonlFiles) {
    const agentId = jsonlFile.replace('.jsonl', '');
    const jsonlPath = path.join(subagentDir, jsonlFile);
    const metaPath = path.join(subagentDir, `${agentId}.meta.json`);

    let agentType = '';
    let description = '';
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        agentType = meta.agentType ?? '';
        description = meta.description ?? '';
      } catch {
        // skip
      }
    }

    const parsed = parseEntries(readJsonlLines(jsonlPath));

    details.push({
      agentId,
      agentType,
      description,
      model: parsed.model,
      tokens: parsed.tokens,
      toolCalls: parsed.toolCalls,
      toolBytes: parsed.toolBytes,
      toolBreakdown: parsed.toolBreakdown,
      skills: parsed.skills,
    });
  }

  return details;
}

function getSessionDetail(sessionFilePath: string): SessionDetail {
  const summary = parseSessionFile(sessionFilePath);
  const subagents = parseSubagentDetails(sessionFilePath);
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
        const aTotal = a.tokens.input + a.tokens.cacheRead + a.tokens.output;
        const bTotal = b.tokens.input + b.tokens.cacheRead + b.tokens.output;
        return bTotal - aTotal;
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
// Human-Readable Output: Session Detail
// ---------------------------------------------------------------------------

function printSessionDetail(detail: SessionDetail): void {
  const w = (label: string, value: string) => console.log(`  ${c(COLORS.label, label.padEnd(28))} ${value}`);

  console.log(c(COLORS.bold, 'Session') + '  ' + c(COLORS.session, detail.sessionId));
  console.log(c(COLORS.bold, 'Model') + '    ' + c(COLORS.model, detail.model || '—'));
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
  w('Input (+ cache create)', c(COLORS.input, fmtSi(detail.tokens.input)));
  w('Cache read', c(COLORS.cached, fmtSi(detail.tokens.cacheRead)));
  w('Output', c(COLORS.output, fmtSi(detail.tokens.output)));
  console.log();

  console.log(c(COLORS.bold, 'Tools') + '    ' + c(COLORS.tools, `${fmtNumber(detail.toolCalls)} calls`));
  if (detail.toolBytes > 0) {
    console.log('         ' + c(COLORS.label, `~${fmtSi(Math.floor(detail.toolBytes / 4))} est. result tokens`));
  }
  const sortedTools = Object.entries(detail.toolBreakdown).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sortedTools) {
    console.log('  ' + c(COLORS.tools, String(count).padStart(6)) + '  ' + c(COLORS.label, name));
  }
  console.log();

  if (detail.skills.length > 0) {
    console.log(
      c(COLORS.bold, 'Skills') + '   ' + detail.skills.map((s) => c(COLORS.model, s)).join(c(COLORS.grey, ', ')),
    );
    console.log();
  }

  if (detail.subagents.length > 0) {
    console.log(c(COLORS.bold, 'Subagents') + ` (${c(COLORS.agents, String(detail.subagents.length))})`);
    for (const sa of detail.subagents) {
      console.log(
        '  ' +
          c(COLORS.agents, sa.agentId) +
          '  ' +
          c(COLORS.model, sa.agentType) +
          '  ' +
          c(COLORS.grey, `"${sa.description}"`) +
          (sa.model ? '  ' + c(COLORS.session, sa.model) : ''),
      );
      const tokenStr = `${fmtSi(sa.tokens.input)} in / ${fmtSi(sa.tokens.cacheRead)} cached / ${fmtSi(sa.tokens.output)} out`;
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
      if (sa.skills.length > 0) {
        console.log(
          '    ' +
            c(COLORS.label, 'Skills') +
            '  ' +
            sa.skills.map((s) => c(COLORS.model, s)).join(c(COLORS.grey, ', ')),
        );
      }
    }
  } else {
    console.log(c(COLORS.bold, 'Subagents') + '  none');
  }
}

function aggregateTotals(sessions: SessionSummary[]) {
  return sessions.reduce(
    (acc, s) => ({
      input: acc.input + s.tokens.input,
      cached: acc.cached + s.tokens.cacheRead,
      output: acc.output + s.tokens.output,
      tools: acc.tools + s.toolCalls,
      agents: acc.agents + s.subagentCount,
    }),
    { input: 0, cached: 0, output: 0, tools: 0, agents: 0 },
  );
}

// ---------------------------------------------------------------------------
// Human-Readable Output: Session List
// ---------------------------------------------------------------------------

function printSessionTable(sessions: SessionSummary[], projectSlug: string): void {
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

  console.log(c(COLORS.bold, 'Project') + '  ' + c(COLORS.session, projectSlug));
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

  // Column widths
  const cols = {
    session: 36,
    start: 11,
    dur: 9,
    turns: 5,
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
      c(COLORS.input, fmtSi(s.tokens.input).padStart(cols.input)) +
      '  ' +
      c(COLORS.cached, fmtSi(s.tokens.cacheRead).padStart(cols.cached)) +
      '  ' +
      c(COLORS.output, fmtSi(s.tokens.output).padStart(cols.output)) +
      '  ' +
      c(COLORS.tools, String(s.toolCalls).padStart(cols.tools)) +
      '  ' +
      c(COLORS.agents, String(s.subagentCount).padStart(cols.agents));
    console.log(row);
  }

  // Totals
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
    start: s.startTime,
    end: s.endTime,
    duration_seconds: s.durationSecs,
    user_turns: s.userTurns,
    tokens: {
      input: s.tokens.input,
      cache_read: s.tokens.cacheRead,
      output: s.tokens.output,
    },
    tool_calls: s.toolCalls,
    tool_bytes: s.toolBytes,
    tool_breakdown: s.toolBreakdown,
    skills: s.skills,

    subagent_count: s.subagentCount,
  };
}

function sessionDetailToJson(d: SessionDetail): object {
  return {
    ...sessionSummaryToJson(d),
    subagents: d.subagents.map((sa) => ({
      agent_id: sa.agentId,
      agent_type: sa.agentType,
      description: sa.description,
      model: sa.model,
      tokens: {
        input: sa.tokens.input,
        cache_read: sa.tokens.cacheRead,
        output: sa.tokens.output,
      },
      tool_calls: sa.toolCalls,
      tool_bytes: sa.toolBytes,
      tool_breakdown: sa.toolBreakdown,
      skills: sa.skills,
    })),
  };
}

function printListJson(sessions: SessionSummary[], projectSlug: string): void {
  const totals = aggregateTotals(sessions);

  console.log(
    JSON.stringify(
      {
        project: projectSlug,
        session_count: sessions.length,
        totals: {
          tokens: {
            input: totals.input,
            cache_read: totals.cached,
            output: totals.output,
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
// Session UUID resolution
// ---------------------------------------------------------------------------

function resolveSessionFile(projectDir: string, sessionId: string): string {
  // Try exact match first
  const exact = path.join(projectDir, `${sessionId}.jsonl`);
  if (fs.existsSync(exact)) return exact;

  // Try prefix match
  const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl') && f.startsWith(sessionId));
  if (files.length === 1) return path.join(projectDir, files[0]!);
  if (files.length > 1) {
    console.error(`Ambiguous session prefix "${sessionId}", matches:`);
    for (const f of files) console.error(`  ${f.replace('.jsonl', '')}`);
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

  const projectDir = resolveProjectDir(args);
  const projectSlug = path.basename(projectDir);

  if (args.command === 'session') {
    const sessionFile = resolveSessionFile(projectDir, args.sessionId);
    const detail = getSessionDetail(sessionFile);

    if (args.json) {
      console.log(JSON.stringify(sessionDetailToJson(detail), null, 2));
    } else {
      printSessionDetail(detail);
    }
    return;
  }

  // list command (default)
  const sessionFiles = listSessionFiles(projectDir);
  let sessions = sessionFiles.map(parseSessionFile);
  sessions = sortSessions(sessions, args.sort);
  if (args.limit > 0) sessions = sessions.slice(0, args.limit);

  if (args.json) {
    printListJson(sessions, projectSlug);
  } else {
    printSessionTable(sessions, projectSlug);
  }
}

main();
