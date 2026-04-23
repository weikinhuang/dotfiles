// Shared human-readable and JSON renderers for session-usage scripts.
// SPDX-License-Identifier: MIT

import { COLORS, c, fmtCost, fmtDate, fmtDateFull, fmtDuration, fmtNumber, fmtSi, padEndVisible } from './format.ts';
import type { ModelTokenBreakdown, SessionDetail, SessionSummary, SessionTokens, Subagent } from './types.ts';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

type ColAlign = 'left' | 'right';

function padCol(text: string, width: number, align: ColAlign = 'left'): string {
  return align === 'right' ? text.padStart(width) : padEndVisible(text, width);
}

function computeDateRange(sessions: { startTime: string }[]): { start: string; end: string } {
  const dates = sessions
    .map((s) => s.startTime)
    .filter(Boolean)
    .sort();
  const start = dates[0] ? fmtDateFull(dates[0]!).slice(0, 10) : '—';
  const end = dates.length > 0 ? fmtDateFull(dates[dates.length - 1]!).slice(0, 10) : '—';
  return { start, end };
}

function formatInlineToolBreakdown(toolBreakdown: Record<string, number>): string {
  return Object.entries(toolBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}:${count}`)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Sorting (generic across tools)
// ---------------------------------------------------------------------------

export function sortSessions(sessions: SessionSummary[], field: string): SessionSummary[] {
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
      sorted.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
      break;
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface Totals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  toolCalls: number;
  subagents: number;
  cost: number;
}

function aggregateTotals(sessions: SessionSummary[]): Totals {
  return sessions.reduce<Totals>(
    (acc, s) => ({
      input: acc.input + s.tokens.input,
      cacheRead: acc.cacheRead + s.tokens.cacheRead,
      cacheWrite: acc.cacheWrite + (s.tokens.cacheWrite ?? 0),
      output: acc.output + s.tokens.output,
      reasoning: acc.reasoning + (s.tokens.reasoning ?? 0),
      toolCalls: acc.toolCalls + s.toolCalls,
      subagents: acc.subagents + s.subagentCount,
      cost: acc.cost + (s.cost ?? 0),
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, toolCalls: 0, subagents: 0, cost: 0 },
  );
}

// ---------------------------------------------------------------------------
// Bucketing (day / week) for totals command
// ---------------------------------------------------------------------------

export type GroupBy = 'day' | 'week';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function bucketKey(iso: string, groupBy: GroupBy): string {
  const d = new Date(iso);
  if (groupBy === 'week') {
    // Monday as the first day of the week. JS Sunday=0..Saturday=6.
    const day = d.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + mondayOffset);
    return `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

interface Bucket {
  key: string;
  sessions: SessionSummary[];
  totals: Totals;
}

function bucketSessions(sessions: SessionSummary[], groupBy: GroupBy): Bucket[] {
  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    if (!s.startTime) continue;
    const key = bucketKey(s.startTime, groupBy);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const buckets: Bucket[] = [];
  for (const [key, group] of groups) {
    buckets.push({ key, sessions: group, totals: aggregateTotals(group) });
  }
  return buckets;
}

function sortBuckets(buckets: Bucket[], field: string): Bucket[] {
  const sorted = [...buckets];
  switch (field) {
    case 'tokens':
      sorted.sort((a, b) => b.totals.input + b.totals.output - (a.totals.input + a.totals.output));
      break;
    case 'cost':
      sorted.sort((a, b) => b.totals.cost - a.totals.cost);
      break;
    case 'tools':
      sorted.sort((a, b) => b.totals.toolCalls - a.totals.toolCalls);
      break;
    case 'date':
    default:
      sorted.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      break;
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Session list (table)
// ---------------------------------------------------------------------------

interface ListColumn {
  header: string;
  width: number;
  align: ColAlign;
  color: string;
  get: (s: SessionSummary) => string;
}

function buildListColumns(sessions: SessionSummary[]): ListColumn[] {
  const showTitle = sessions.some((s) => !!s.title);
  const models = new Set(sessions.map((s) => s.model).filter(Boolean));
  const showModel = models.size > 1;
  const showCost = sessions.some((s) => (s.cost ?? 0) > 0);

  const cols: ListColumn[] = [];
  cols.push({
    header: 'SESSION',
    width: 36,
    align: 'left',
    color: COLORS.session,
    get: (s) => s.sessionId,
  });
  if (showTitle) {
    cols.push({
      header: 'TITLE',
      width: 28,
      align: 'left',
      color: COLORS.label,
      get: (s) => s.title ?? '',
    });
  }
  cols.push({
    header: 'START',
    width: 11,
    align: 'left',
    color: COLORS.time,
    get: (s) => fmtDate(s.startTime),
  });
  cols.push({
    header: 'DURATION',
    width: 9,
    align: 'right',
    color: COLORS.time,
    get: (s) => fmtDuration(s.durationSecs),
  });
  cols.push({
    header: 'TURNS',
    width: 5,
    align: 'right',
    color: COLORS.turns,
    get: (s) => String(s.userTurns),
  });
  if (showModel) {
    cols.push({
      header: 'MODEL',
      width: 16,
      align: 'left',
      color: COLORS.model,
      get: (s) => s.model,
    });
  }
  cols.push({
    header: 'INPUT',
    width: 8,
    align: 'right',
    color: COLORS.input,
    get: (s) => fmtSi(s.tokens.input),
  });
  cols.push({
    header: 'CACHED',
    width: 8,
    align: 'right',
    color: COLORS.cached,
    get: (s) => fmtSi(s.tokens.cacheRead),
  });
  cols.push({
    header: 'OUTPUT',
    width: 8,
    align: 'right',
    color: COLORS.output,
    get: (s) => fmtSi(s.tokens.output),
  });
  cols.push({
    header: 'TOOLS',
    width: 6,
    align: 'right',
    color: COLORS.tools,
    get: (s) => String(s.toolCalls),
  });
  cols.push({
    header: 'AGENTS',
    width: 6,
    align: 'right',
    color: COLORS.agents,
    get: (s) => String(s.subagentCount),
  });
  if (showCost) {
    cols.push({
      header: 'COST',
      width: 8,
      align: 'right',
      color: COLORS.cost,
      get: (s) => fmtCost(s.cost ?? 0),
    });
  }
  return cols;
}

function printListTotals(sessions: SessionSummary[]): void {
  const totals = aggregateTotals(sessions);
  const showReasoning = totals.reasoning > 0;
  const showCost = totals.cost > 0;

  const parts: string[] = [c(COLORS.bold, 'Totals')];
  parts.push(c(COLORS.label, 'Input') + '  ' + c(COLORS.input, fmtSi(totals.input)));
  parts.push(c(COLORS.label, 'Cached') + '  ' + c(COLORS.cached, fmtSi(totals.cacheRead)));
  parts.push(c(COLORS.label, 'Output') + '  ' + c(COLORS.output, fmtSi(totals.output)));
  if (showReasoning) {
    parts.push(c(COLORS.label, 'Reasoning') + '  ' + c(COLORS.reasoning, fmtSi(totals.reasoning)));
  }
  parts.push(c(COLORS.label, 'Tools') + '  ' + c(COLORS.tools, fmtNumber(totals.toolCalls)));
  parts.push(c(COLORS.label, 'Agents') + '  ' + c(COLORS.agents, String(totals.subagents)));
  if (showCost) {
    parts.push(c(COLORS.label, 'Cost') + '  ' + c(COLORS.cost, fmtCost(totals.cost)));
  }
  console.log(parts.join('    '));
}

export function printSessionTable(sessions: SessionSummary[], label?: string): void {
  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  const range = computeDateRange(sessions);
  if (label) {
    console.log(c(COLORS.bold, 'Project') + '  ' + c(COLORS.session, label));
  }
  console.log(
    c(COLORS.bold, 'Sessions') +
      ' ' +
      c(COLORS.turns, String(sessions.length)) +
      '    ' +
      c(COLORS.bold, 'Range') +
      '  ' +
      c(COLORS.time, `${range.start} — ${range.end}`),
  );
  console.log();

  const cols = buildListColumns(sessions);
  console.log(cols.map((col) => c(COLORS.header, padCol(col.header, col.width, col.align))).join('  '));
  for (const s of sessions) {
    console.log(cols.map((col) => c(col.color, padCol(col.get(s), col.width, col.align))).join('  '));
  }

  console.log();
  printListTotals(sessions);
}

// ---------------------------------------------------------------------------
// Session detail
// ---------------------------------------------------------------------------

function printDetailLabel(label: string, value: string, labelPadding: number = 8): void {
  console.log(c(COLORS.bold, label.padEnd(labelPadding)) + ' ' + c(COLORS.label, value));
}

function printLabeledValue(label: string, value: string, labelWidth: number = 28): void {
  console.log(`  ${c(COLORS.label, label.padEnd(labelWidth))} ${value}`);
}

function printTokenBlock(tokens: SessionTokens, cost?: number): void {
  console.log(c(COLORS.bold, 'Tokens'));
  printLabeledValue('Input', c(COLORS.input, fmtSi(tokens.input)));
  if ((tokens.cacheWrite ?? 0) > 0) {
    printLabeledValue('Cache write', c(COLORS.cached, fmtSi(tokens.cacheWrite!)));
  }
  printLabeledValue('Cache read', c(COLORS.cached, fmtSi(tokens.cacheRead)));
  printLabeledValue('Output', c(COLORS.output, fmtSi(tokens.output)));
  if ((tokens.reasoning ?? 0) > 0) {
    printLabeledValue('Reasoning', c(COLORS.reasoning, fmtSi(tokens.reasoning!)));
  }
  if ((cost ?? 0) > 0) {
    printLabeledValue('Cost', c(COLORS.cost, fmtCost(cost!)));
  }
  console.log();
}

function printToolsSection(detail: SessionDetail): void {
  console.log(c(COLORS.bold, 'Tools') + '    ' + c(COLORS.tools, `${fmtNumber(detail.toolCalls)} calls`));
  if (detail.toolBytes && detail.toolBytes > 0) {
    console.log('         ' + c(COLORS.label, `~${fmtSi(Math.floor(detail.toolBytes / 4))} est. result tokens`));
  }
  const sorted = Object.entries(detail.toolBreakdown).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    console.log('  ' + c(COLORS.tools, String(count).padStart(6)) + '  ' + c(COLORS.label, name));
  }
  console.log();
}

function printModelBreakdown(breakdown: ModelTokenBreakdown[] | undefined, indent: string = ''): void {
  if (!breakdown || breakdown.length < 2) return;
  const sorted = [...breakdown].sort((a, b) => b.tokens.output - a.tokens.output);
  const header = indent === '' ? c(COLORS.bold, 'Models') : indent + c(COLORS.label, 'Models');
  console.log(header);
  for (const mb of sorted) {
    const parts: string[] = [];
    parts.push(`${fmtSi(mb.tokens.input)} in`);
    if ((mb.tokens.cacheWrite ?? 0) > 0) {
      parts.push(`${fmtSi(mb.tokens.cacheWrite!)} cache write`);
    }
    parts.push(`${fmtSi(mb.tokens.cacheRead)} cached`);
    parts.push(`${fmtSi(mb.tokens.output)} out`);
    if ((mb.tokens.reasoning ?? 0) > 0) {
      parts.push(`${fmtSi(mb.tokens.reasoning!)} reasoning`);
    }
    const prefix = indent === '' ? '  ' : indent + '  ';
    const line = prefix + c(COLORS.model, padEndVisible(mb.model, 28)) + '  ' + c(COLORS.label, parts.join(' / '));
    const costSuffix = (mb.cost ?? 0) > 0 ? '    ' + c(COLORS.cost, fmtCost(mb.cost!)) : '';
    console.log(line + costSuffix);
  }
  if (indent === '') console.log();
}

function printSkills(skills: string[] | undefined, indent: string = ''): void {
  if (!skills || skills.length === 0) return;
  const rendered = skills.map((s) => c(COLORS.model, s)).join(c(COLORS.grey, ', '));
  if (indent === '') {
    console.log(c(COLORS.bold, 'Skills') + '   ' + rendered);
    console.log();
  } else {
    console.log(indent + c(COLORS.label, 'Skills') + '  ' + rendered);
  }
}

function printSubagent(sa: Subagent): void {
  const header: string[] = [c(COLORS.agents, sa.agentId)];
  if (sa.agentLabel) header.push(c(COLORS.model, sa.agentLabel));
  if (sa.role) header.push(c(COLORS.model, sa.role));
  if (sa.description) header.push(c(COLORS.grey, `"${sa.description}"`));
  if (sa.model) header.push(c(COLORS.session, sa.model));
  console.log('  ' + header.join('  '));

  const tokenParts: string[] = [];
  tokenParts.push(`${fmtSi(sa.tokens.input)} in`);
  if ((sa.tokens.cacheWrite ?? 0) > 0) {
    tokenParts.push(`${fmtSi(sa.tokens.cacheWrite!)} cache write`);
  }
  tokenParts.push(`${fmtSi(sa.tokens.cacheRead)} cached`);
  tokenParts.push(`${fmtSi(sa.tokens.output)} out`);
  if ((sa.tokens.reasoning ?? 0) > 0) {
    tokenParts.push(`${fmtSi(sa.tokens.reasoning!)} reasoning`);
  }

  const line2: string[] = [];
  line2.push(c(COLORS.label, 'Tokens') + '  ' + tokenParts.join(' / '));
  line2.push(c(COLORS.label, 'Tools') + '  ' + c(COLORS.tools, String(sa.toolCalls)));
  if ((sa.cost ?? 0) > 0) {
    line2.push(c(COLORS.label, 'Cost') + '  ' + c(COLORS.cost, fmtCost(sa.cost!)));
  }
  console.log('    ' + line2.join('    '));

  const inline = formatInlineToolBreakdown(sa.toolBreakdown);
  if (inline) console.log('    ' + c(COLORS.grey, inline));

  printModelBreakdown(sa.modelBreakdown, '    ');
  printSkills(sa.skills, '    ');
}

export function printSessionDetail(detail: SessionDetail): void {
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
    printDetailLabel('Version', detail.version);
  }
  console.log();

  printTokenBlock(detail.tokens, detail.cost);
  printModelBreakdown(detail.modelBreakdown);
  printToolsSection(detail);
  printSkills(detail.skills);

  if (detail.subagents.length === 0) {
    console.log(c(COLORS.bold, 'Subagents') + '  none');
  } else {
    console.log(c(COLORS.bold, 'Subagents') + ` (${c(COLORS.agents, String(detail.subagents.length))})`);
    for (const sa of detail.subagents) {
      printSubagent(sa);
    }
  }
}

// ---------------------------------------------------------------------------
// JSON output (canonical shape)
// ---------------------------------------------------------------------------

function tokensToJson(t: SessionTokens): Record<string, number> {
  const obj: Record<string, number> = {
    input: t.input,
    cache_read: t.cacheRead,
    output: t.output,
  };
  if (t.cacheWrite !== undefined) obj.cache_write = t.cacheWrite;
  if (t.reasoning !== undefined) obj.reasoning = t.reasoning;
  return obj;
}

function modelBreakdownToJson(bs: ModelTokenBreakdown[]): Record<string, unknown>[] {
  return bs.map((mb) => {
    const obj: Record<string, unknown> = {
      model: mb.model,
      tokens: tokensToJson(mb.tokens),
    };
    if (mb.cost !== undefined) obj.cost = mb.cost;
    return obj;
  });
}

function subagentToJson(sa: Subagent): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    agent_id: sa.agentId,
    agent_label: sa.agentLabel,
    model: sa.model,
    tokens: tokensToJson(sa.tokens),
    tool_calls: sa.toolCalls,
    tool_breakdown: sa.toolBreakdown,
  };
  if (sa.role !== undefined) obj.role = sa.role;
  if (sa.description !== undefined) obj.description = sa.description;
  if (sa.skills !== undefined) obj.skills = sa.skills;
  if (sa.cost !== undefined) obj.cost = sa.cost;
  if (sa.modelBreakdown !== undefined) obj.model_breakdown = modelBreakdownToJson(sa.modelBreakdown);
  return obj;
}

function summaryToJson(s: SessionSummary): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    session_id: s.sessionId,
    model: s.model,
    start: s.startTime,
    end: s.endTime,
    duration_seconds: s.durationSecs,
    user_turns: s.userTurns,
    tokens: tokensToJson(s.tokens),
    tool_calls: s.toolCalls,
    tool_breakdown: s.toolBreakdown,
    subagent_count: s.subagentCount,
  };
  if (s.title !== undefined) obj.title = s.title;
  if (s.agent !== undefined) obj.agent = s.agent;
  if (s.directory !== undefined) obj.directory = s.directory;
  if (s.version !== undefined) obj.version = s.version;
  if (s.toolBytes !== undefined) obj.tool_bytes = s.toolBytes;
  if (s.skills !== undefined) obj.skills = s.skills;
  if (s.cost !== undefined) obj.cost = s.cost;
  if (s.modelBreakdown !== undefined) obj.model_breakdown = modelBreakdownToJson(s.modelBreakdown);
  return obj;
}

export function printDetailJson(detail: SessionDetail): void {
  const obj = summaryToJson(detail);
  obj.subagents = detail.subagents.map(subagentToJson);
  console.log(JSON.stringify(obj, null, 2));
}

export function printListJson(sessions: SessionSummary[], label?: string): void {
  const totals = aggregateTotals(sessions);
  const totalsJson: Record<string, unknown> = {
    tokens: {
      input: totals.input,
      cache_read: totals.cacheRead,
      cache_write: totals.cacheWrite,
      output: totals.output,
      reasoning: totals.reasoning,
    },
    tool_calls: totals.toolCalls,
    subagents: totals.subagents,
    cost: totals.cost,
  };
  const obj: Record<string, unknown> = {
    session_count: sessions.length,
    totals: totalsJson,
    sessions: sessions.map(summaryToJson),
  };
  if (label) obj.label = label;
  console.log(JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------------------
// Totals table / JSON (grouped by day or week)
// ---------------------------------------------------------------------------

interface TotalsColumn {
  header: string;
  width: number;
  align: ColAlign;
  color: string;
  get: (b: Bucket) => string;
  include: (buckets: Bucket[]) => boolean;
}

function buildTotalsColumns(groupBy: GroupBy): TotalsColumn[] {
  const periodHeader = groupBy === 'week' ? 'WEEK OF' : 'DATE';
  return [
    {
      header: periodHeader,
      width: 10,
      align: 'left',
      color: COLORS.time,
      get: (b) => b.key,
      include: () => true,
    },
    {
      header: 'SESSIONS',
      width: 8,
      align: 'right',
      color: COLORS.turns,
      get: (b) => String(b.sessions.length),
      include: () => true,
    },
    {
      header: 'INPUT',
      width: 8,
      align: 'right',
      color: COLORS.input,
      get: (b) => fmtSi(b.totals.input),
      include: () => true,
    },
    {
      header: 'CACHED',
      width: 8,
      align: 'right',
      color: COLORS.cached,
      get: (b) => fmtSi(b.totals.cacheRead),
      include: () => true,
    },
    {
      header: 'OUTPUT',
      width: 8,
      align: 'right',
      color: COLORS.output,
      get: (b) => fmtSi(b.totals.output),
      include: () => true,
    },
    {
      header: 'REASON',
      width: 8,
      align: 'right',
      color: COLORS.reasoning,
      get: (b) => fmtSi(b.totals.reasoning),
      include: (bs) => bs.some((b) => b.totals.reasoning > 0),
    },
    {
      header: 'TOOLS',
      width: 7,
      align: 'right',
      color: COLORS.tools,
      get: (b) => fmtNumber(b.totals.toolCalls),
      include: () => true,
    },
    {
      header: 'COST',
      width: 8,
      align: 'right',
      color: COLORS.cost,
      get: (b) => fmtCost(b.totals.cost),
      include: (bs) => bs.some((b) => b.totals.cost > 0),
    },
  ];
}

export function printTotalsTable(
  sessions: SessionSummary[],
  groupBy: GroupBy,
  sortField: string,
  limit: number,
  label?: string,
): void {
  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  let buckets = bucketSessions(sessions, groupBy);
  buckets = sortBuckets(buckets, sortField);
  if (limit > 0) buckets = buckets.slice(0, limit);

  const range = computeDateRange(sessions);
  const overall = aggregateTotals(sessions);

  if (label) {
    console.log(c(COLORS.bold, 'Scope') + '    ' + c(COLORS.session, label));
  } else {
    console.log(c(COLORS.bold, 'Scope') + '    ' + c(COLORS.session, 'all projects'));
  }
  console.log(
    c(COLORS.bold, 'Sessions') +
      ' ' +
      c(COLORS.turns, String(sessions.length)) +
      '    ' +
      c(COLORS.bold, 'Range') +
      '    ' +
      c(COLORS.time, `${range.start} — ${range.end}`) +
      '    ' +
      c(COLORS.bold, 'Group') +
      '    ' +
      c(COLORS.label, groupBy),
  );
  console.log();

  const cols = buildTotalsColumns(groupBy).filter((col) => col.include(buckets));
  console.log(cols.map((col) => c(COLORS.header, padCol(col.header, col.width, col.align))).join('  '));
  for (const b of buckets) {
    console.log(cols.map((col) => c(col.color, padCol(col.get(b), col.width, col.align))).join('  '));
  }

  console.log();
  const parts: string[] = [c(COLORS.bold, 'Totals')];
  parts.push(c(COLORS.label, 'Input') + '  ' + c(COLORS.input, fmtSi(overall.input)));
  parts.push(c(COLORS.label, 'Cached') + '  ' + c(COLORS.cached, fmtSi(overall.cacheRead)));
  parts.push(c(COLORS.label, 'Output') + '  ' + c(COLORS.output, fmtSi(overall.output)));
  if (overall.reasoning > 0) {
    parts.push(c(COLORS.label, 'Reasoning') + '  ' + c(COLORS.reasoning, fmtSi(overall.reasoning)));
  }
  parts.push(c(COLORS.label, 'Tools') + '  ' + c(COLORS.tools, fmtNumber(overall.toolCalls)));
  if (overall.cost > 0) {
    parts.push(c(COLORS.label, 'Cost') + '  ' + c(COLORS.cost, fmtCost(overall.cost)));
  }
  console.log(parts.join('    '));
}

export function printTotalsJson(
  sessions: SessionSummary[],
  groupBy: GroupBy,
  sortField: string,
  limit: number,
  label?: string,
): void {
  let buckets = bucketSessions(sessions, groupBy);
  buckets = sortBuckets(buckets, sortField);
  if (limit > 0) buckets = buckets.slice(0, limit);
  const overall = aggregateTotals(sessions);

  const obj: Record<string, unknown> = {
    group_by: groupBy,
    session_count: sessions.length,
    totals: {
      tokens: {
        input: overall.input,
        cache_read: overall.cacheRead,
        cache_write: overall.cacheWrite,
        output: overall.output,
        reasoning: overall.reasoning,
      },
      tool_calls: overall.toolCalls,
      subagents: overall.subagents,
      cost: overall.cost,
    },
    buckets: buckets.map((b) => ({
      period: b.key,
      sessions: b.sessions.length,
      tokens: {
        input: b.totals.input,
        cache_read: b.totals.cacheRead,
        cache_write: b.totals.cacheWrite,
        output: b.totals.output,
        reasoning: b.totals.reasoning,
      },
      tool_calls: b.totals.toolCalls,
      subagents: b.totals.subagents,
      cost: b.totals.cost,
    })),
  };
  if (label) obj.label = label;
  console.log(JSON.stringify(obj, null, 2));
}
