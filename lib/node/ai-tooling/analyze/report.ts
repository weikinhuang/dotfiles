// Renders an analyzed session (totals + cost split + findings) to a terminal
// report or a machine-readable JSON object. Pure: takes the already-analyzed
// session + findings and returns strings/objects; the CLI handles printing.
// SPDX-License-Identifier: MIT

import { c, COLORS, fmtCost, fmtDateFull, fmtDuration, fmtSi } from '../format.ts';
import { type Finding, type Severity } from './detectors.ts';
import { modelChanges, type NormalizedSession, sessionCostTotals, turnContextTokens } from './turn-model.ts';

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

function severityBadge(sev: Severity): string {
  const label = sev.toUpperCase();
  if (sev === 'critical') return c(COLORS.input, label);
  if (sev === 'warn') return c(COLORS.output, label);
  return c(COLORS.grey, label);
}

function turnRangeLabel(f: Finding): string {
  const { startIndex, endIndex, turnCount } = f.range;
  return startIndex === endIndex ? `turn ${startIndex}` : `turns ${startIndex}-${endIndex} (${turnCount})`;
}

// Peak per-turn context across the session, for the "carry" headline.
function peakContext(session: NormalizedSession): number {
  let peak = 0;
  for (const t of session.turns) peak = Math.max(peak, turnContextTokens(t));
  return peak;
}

export interface ReportOptions {
  // When false, suppress the "no findings" healthy banner (used in batch).
  showHealthy?: boolean;
  // When true, append a per-turn table (cacheRead / cacheWrite / cost / tags).
  turns?: boolean;
}

// Short per-turn tags for the localized detectors (cache-write-dominant spans
// the whole session, so tagging every turn with it would be noise).
const TURN_TAG: Partial<Record<Finding['detector'], string>> = {
  'cache-poisoning': 'poison',
  'ttl-expiry': 'ttl',
  'cache-bust': 'bust',
  'large-context-carry': 'large-ctx',
};

function buildTurnTags(findings: Finding[]): Map<number, string[]> {
  const tags = new Map<number, string[]>();
  for (const f of findings) {
    const tag = TURN_TAG[f.detector];
    if (!tag) continue;
    for (let i = f.range.startIndex; i <= f.range.endIndex; i++) {
      const list = tags.get(i) ?? [];
      if (!list.includes(tag)) list.push(tag);
      tags.set(i, list);
    }
  }
  return tags;
}

// Strips a known provider prefix for a compact model label in the report.
function shortModel(id: string): string {
  return id
    .replace(/^(us|eu|apac)\.(anthropic|amazon|bedrock)\./i, '')
    .replace(/^(anthropic|openai|google|amazon|bedrock)\//i, '');
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function clockOf(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function gapLabel(secs: number | undefined): string {
  if (secs === undefined || secs < 60) return '-';
  return fmtDuration(Math.round(secs));
}

// Renders the per-turn table: index, clock, idle gap, cacheRead, cacheWrite,
// output, context, per-turn cost, and any localized-detector tags.
function renderTurns(session: NormalizedSession, findings: Finding[]): string[] {
  const tags = buildTurnTags(findings);
  const modelAt = new Map<number, string>();
  for (const mc of modelChanges(session)) modelAt.set(mc.index, shortModel(mc.to));
  const lines: string[] = ['', c(COLORS.header, 'Per-turn')];
  lines.push(
    c(
      COLORS.header,
      `  ${pad('#', 4)} ${pad('time', 5)} ${pad('gap', 6)} ${pad('cacheR', 7)} ${pad('cacheW', 7)} ` +
        `${pad('out', 6)} ${pad('ctx', 7)} ${pad('$turn', 8)}  message`,
    ),
  );
  for (const t of session.turns) {
    const tag = (tags.get(t.index) ?? []).join(',');
    const cost = t.cost ? fmtCost(t.cost.total) : '-';
    const switched = modelAt.get(t.index);
    // Model marker, finding tag, and message preview share the trailing column.
    const trailer = [
      switched ? c(COLORS.model, `[→${switched}]`) : '',
      tag ? c(COLORS.output, `[${tag}]`) : '',
      c(COLORS.grey, t.preview ?? ''),
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(
      `  ${pad(String(t.index), 4)} ${pad(clockOf(t.timestamp), 5)} ${pad(gapLabel(t.gapSecFromPrev), 6)} ` +
        `${pad(fmtSi(t.tokens.cacheReadInput), 7)} ${c(COLORS.input, pad(fmtSi(t.tokens.cacheWriteInput), 7))} ` +
        `${pad(fmtSi(t.tokens.output), 6)} ${pad(fmtSi(turnContextTokens(t)), 7)} ${pad(cost, 8)}  ${trailer}`,
    );
  }
  return lines;
}

export function renderReport(session: NormalizedSession, findings: Finding[], opts: ReportOptions = {}): string {
  const totals = sessionCostTotals(session);
  const lines: string[] = [];

  lines.push(c(COLORS.bold, `session-doctor: ${session.harness} ${session.sessionId}`));
  const modelLabel = session.model || 'unknown-model';
  lines.push(`  ${c(COLORS.model, modelLabel)}  ${c(COLORS.turns, `${session.turns.length} turns`)}`);
  if (session.startTime) {
    lines.push(`  ${c(COLORS.time, fmtDateFull(session.startTime))} → ${c(COLORS.time, fmtDateFull(session.endTime))}`);
  }

  lines.push('');
  lines.push(c(COLORS.header, 'Cost'));
  lines.push(`  total       ${c(COLORS.cost, fmtCost(totals.total))}`);
  lines.push(`  input       ${fmtCost(totals.input)}`);
  lines.push(`  output      ${fmtCost(totals.output)}`);
  lines.push(`  cacheRead   ${c(COLORS.cached, fmtCost(totals.cacheRead))}`);
  lines.push(`  cacheWrite  ${c(COLORS.input, fmtCost(totals.cacheWrite))}`);
  const writeShare = totals.total > 0 ? (totals.cacheWrite / totals.total) * 100 : 0;
  lines.push(`  write share ${writeShare.toFixed(0)}%   peak context ${fmtSi(peakContext(session))} tokens`);

  const changes = modelChanges(session);
  if (changes.length > 0) {
    lines.push('');
    lines.push(c(COLORS.header, `Model changes (${changes.length})`));
    for (const mc of changes) {
      lines.push(`  turn ${mc.index}  ${c(COLORS.model, shortModel(mc.from))} → ${c(COLORS.model, shortModel(mc.to))}`);
    }
  }

  lines.push('');
  if (findings.length === 0) {
    if (opts.showHealthy !== false) {
      lines.push(c(COLORS.cached, '✓ no cost/caching pathologies detected'));
    }
    if (opts.turns) lines.push(...renderTurns(session, findings));
    return lines.join('\n');
  }

  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.dollarsAttributed - a.dollarsAttributed,
  );
  // Per-finding dollars are not summed: detectors are overlapping lenses (a
  // poisoned stretch is also counted by cache-write-dominant), so a total
  // would over-attribute past the real session cost.
  lines.push(c(COLORS.header, `Findings (${findings.length})`));
  for (const f of sorted) {
    lines.push(
      `  ${severityBadge(f.severity)} ${c(COLORS.session, f.detector)}  ` +
        `${turnRangeLabel(f)}  ${c(COLORS.cost, fmtCost(f.dollarsAttributed))}`,
    );
    lines.push(`    ${f.explanation}`);
    lines.push(`    ${c(COLORS.label, '→ ' + f.remediation)}`);
  }

  if (opts.turns) lines.push(...renderTurns(session, findings));

  return lines.join('\n');
}

export interface ReportJson {
  harness: string;
  sessionId: string;
  model: string;
  startTime: string;
  endTime: string;
  turns: number;
  cost: ReturnType<typeof sessionCostTotals>;
  writeShare: number;
  peakContextTokens: number;
  modelChanges: { index: number; from: string; to: string; timestamp?: string }[];
  findings: {
    detector: string;
    severity: Severity;
    startIndex: number;
    endIndex: number;
    startTime?: string;
    endTime?: string;
    turnCount: number;
    dollarsAttributed: number;
    explanation: string;
    remediation: string;
  }[];
  // Present only when requested (--turns): the full per-turn series.
  perTurn?: {
    index: number;
    timestamp: string;
    gapSecFromPrev?: number;
    cachingModel: string;
    tokens: { input: number; output: number; cacheReadInput: number; cacheWriteInput: number };
    contextTokens: number;
    preview?: string;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  }[];
}

export function reportJson(session: NormalizedSession, findings: Finding[], includeTurns = false): ReportJson {
  const totals = sessionCostTotals(session);
  const json: ReportJson = {
    harness: session.harness,
    sessionId: session.sessionId,
    model: session.model,
    startTime: session.startTime,
    endTime: session.endTime,
    turns: session.turns.length,
    cost: totals,
    writeShare: totals.total > 0 ? totals.cacheWrite / totals.total : 0,
    peakContextTokens: peakContext(session),
    modelChanges: modelChanges(session),
    findings: findings.map((f) => ({
      detector: f.detector,
      severity: f.severity,
      startIndex: f.range.startIndex,
      endIndex: f.range.endIndex,
      startTime: f.range.startTime,
      endTime: f.range.endTime,
      turnCount: f.range.turnCount,
      dollarsAttributed: f.dollarsAttributed,
      explanation: f.explanation,
      remediation: f.remediation,
    })),
  };
  if (includeTurns) {
    json.perTurn = session.turns.map((t) => ({
      index: t.index,
      timestamp: t.timestamp,
      gapSecFromPrev: t.gapSecFromPrev,
      cachingModel: t.cachingModel,
      tokens: { ...t.tokens },
      contextTokens: turnContextTokens(t),
      preview: t.preview,
      cost: t.cost ? { ...t.cost } : undefined,
    }));
  }
  return json;
}
