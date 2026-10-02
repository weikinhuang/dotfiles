/** Offline, allowlisted trace parsing. Summary output never includes captured prompt/schema text. */
import { unifiedDiffLines } from './checkpoint/diff.ts';
import { traceHash } from './cache-trace-scopes.ts';
import { isRecord } from './shared/guards.ts';

interface ScopeSummary {
  sha256: string;
  bytes: number;
  changed: boolean | null;
}
export interface TraceRequestSummary {
  runId: string;
  sequence: number;
  provider: string;
  model: string;
  firstDivergentMessage: number | null;
  system?: ScopeSummary;
  tools?: ScopeSummary;
  cacheRead: number | null;
  cacheWrite: number | null;
  dollars: number | null;
}

export interface ParsedCacheTrace {
  requests: TraceRequestSummary[];
  snapshots: Map<string, string>;
  warnings: string[];
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function scopeSummary(value: unknown): ScopeSummary | undefined {
  if (!isRecord(value) || !digest(value.sha256) || finite(value.bytes) === null) return undefined;
  return {
    sha256: value.sha256,
    bytes: Number(value.bytes),
    changed: typeof value.changed === 'boolean' ? value.changed : null,
  };
}

function snapshotKey(runId: string, scope: string, sha256: string): string {
  return `${runId}:${scope}:${sha256}`;
}

export function parseCacheTraceJsonl(text: string): ParsedCacheTrace {
  const requests: TraceRequestSummary[] = [];
  const snapshots = new Map<string, string>();
  const warnings: string[] = [];
  const byRequest = new Map<string, TraceRequestSummary>();
  let legacyRun = 1;
  let legacySequence = 0;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      if (index === lines.length - 1 && !text.endsWith('\n')) {
        warnings.push(`Trailing partial record skipped at line ${index + 1}`);
        return;
      }
      throw new Error(`invalid JSON at line ${index + 1} (record content omitted)`);
    }
    if (!isRecord(record)) throw new Error(`invalid trace record at line ${index + 1}`);
    if (record.version !== undefined && record.version !== 1 && record.version !== 2)
      throw new Error(`unsupported trace version at line ${index + 1}`);
    if (
      record.runId !== undefined &&
      (typeof record.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(record.runId))
    )
      throw new Error(`invalid run ID at line ${index + 1}`);
    if (record.kind === 'request' && record.runId === undefined && Number(record.sequence) <= legacySequence)
      legacyRun++;
    const runId = typeof record.runId === 'string' ? record.runId : `legacy-${legacyRun}`;
    if (record.kind === 'snapshot') {
      if (
        (record.scope !== 'system' && record.scope !== 'tools') ||
        !digest(record.sha256) ||
        !digest(record.textSha256) ||
        typeof record.text !== 'string' ||
        traceHash(record.text) !== record.textSha256
      )
        throw new Error(`invalid snapshot or text digest at line ${index + 1}`);
      const key = snapshotKey(runId, record.scope, record.sha256);
      if (snapshots.has(key) && snapshots.get(key) !== record.text)
        throw new Error(`conflicting snapshot at line ${index + 1}`);
      snapshots.set(key, record.text);
      return;
    }
    if (record.kind !== 'request' && record.kind !== 'response')
      throw new Error(`not a cache trace record at line ${index + 1}`);
    if (typeof record.sequence !== 'number' || !Number.isSafeInteger(record.sequence) || record.sequence < 1)
      throw new Error(`invalid request sequence at line ${index + 1}`);
    const key = `${runId}:${record.sequence}`;
    if (record.kind === 'request') {
      if (byRequest.has(key)) throw new Error(`duplicate request sequence at line ${index + 1}`);
      if (record.runId === undefined) legacySequence = record.sequence;
      const row: TraceRequestSummary = {
        runId,
        sequence: record.sequence,
        provider: typeof record.provider === 'string' ? record.provider : 'unknown',
        model: typeof record.model === 'string' ? record.model : 'unknown',
        firstDivergentMessage: finite(record.firstDivergentMessage),
        system: scopeSummary(record.system),
        tools: scopeSummary(record.tools),
        cacheRead: null,
        cacheWrite: null,
        dollars: null,
      };
      requests.push(row);
      byRequest.set(key, row);
    } else {
      const row = byRequest.get(key);
      if (!row) {
        warnings.push(`Unpaired response at line ${index + 1}`);
        return;
      }
      row.cacheRead = finite(record.cacheRead);
      row.cacheWrite = finite(record.cacheWrite);
      row.dollars = isRecord(record.cost) ? finite(record.cost.total) : null;
    }
  });
  return { requests, snapshots, warnings };
}

export function selectTraceRequests(trace: ParsedCacheTrace, runId?: string): TraceRequestSummary[] {
  if (runId === undefined) return trace.requests;
  const runs = [...new Set(trace.requests.map((request) => request.runId))];
  const exact = runs.filter((id) => id === runId);
  const matches = exact.length ? exact : runs.filter((id) => id.startsWith(runId));
  if (matches.length !== 1) throw new Error('run ID is missing or ambiguous; choose an ID from the summary');
  return trace.requests.filter((request) => request.runId === matches[0]);
}

export function selectTraceRequest(trace: ParsedCacheTrace, sequence: number, runId?: string): TraceRequestSummary {
  const rows = selectTraceRequests(trace, runId).filter((request) => request.sequence === sequence);
  if (rows.length !== 1) throw new Error('request sequence is missing or ambiguous; supply --run for multi-run traces');
  return rows[0];
}

function terminalText(text: string): string {
  return Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)
      ? '\\u' + code.toString(16).padStart(4, '0')
      : char;
  }).join('');
}

export function traceSnapshotText(
  trace: ParsedCacheTrace,
  request: TraceRequestSummary,
  scope: 'system' | 'tools',
): string {
  const sha = request[scope]?.sha256;
  const text = sha ? trace.snapshots.get(snapshotKey(request.runId, scope, sha)) : undefined;
  if (text === undefined)
    throw new Error(
      `${scope} text was not captured for request ${request.sequence}; enable ${scope === 'system' ? 'system' : 'system-tools'} logging before reproduction`,
    );
  return terminalText(text);
}

export function diffTraceRequests(
  trace: ParsedCacheTrace,
  from: TraceRequestSummary,
  to: TraceRequestSummary,
  scope: 'system' | 'tools',
): string {
  const before = traceSnapshotText(trace, from, scope);
  const after = traceSnapshotText(trace, to, scope);
  if (before === after) return `${scope}: no text changes`;
  const lines = unifiedDiffLines(before, after)
    .map((line) => `${line.prefix}${line.text}`)
    .join('\n');
  return `--- ${scope} request ${from.sequence}\n+++ ${scope} request ${to.sequence}\n${lines}`;
}

export function renderCacheTraceSummary(requests: readonly TraceRequestSummary[], warnings: readonly string[]): string {
  const lines = [
    'Cache trace (hash-only summary)',
    'run / request | system | tools | historical item | cache read | cache write | USD',
  ];
  const change = (scope: ScopeSummary | undefined): string =>
    scope === undefined ? 'unavailable' : scope.changed === null ? 'baseline' : scope.changed ? 'CHANGED' : 'stable';
  for (const request of requests) {
    lines.push(
      `${request.runId} / ${request.sequence} | ${change(request.system)} | ${change(request.tools)} | ${request.firstDivergentMessage ?? 'stable'} | ${request.cacheRead ?? '?'} | ${request.cacheWrite ?? '?'} | ${request.dollars === null ? '?' : request.dollars.toFixed(6)}`,
    );
  }
  if (!requests.length) lines.push('No requests recorded yet.');
  for (const warning of warnings) lines.push(`Warning: ${warning}`);
  return lines.join('\n');
}
