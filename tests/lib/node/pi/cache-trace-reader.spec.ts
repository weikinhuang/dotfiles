import { expect, test } from 'vitest';

import { createCacheTracer, cacheResponseTrace } from '../../../../lib/node/pi/cache-trace.ts';
import {
  diffTraceRequests,
  parseCacheTraceJsonl,
  renderCacheTraceSummary,
  selectTraceRequest,
  traceSnapshotText,
} from '../../../../lib/node/pi/cache-trace-reader.ts';

function fixture(level: 'hash' | 'system' | 'system-tools' = 'system-tools', runId = 'run1'): string {
  const trace = createCacheTracer({ level, runId });
  const identity = { provider: 'openai', model: 'fixture' };
  const rows: unknown[] = [];
  for (const text of ['SYSTEM one', 'SYSTEM two', 'SYSTEM two']) {
    const { snapshots = [], ...request } = trace(
      { instructions: text, tools: [{ name: text }], input: [{ role: 'user', content: 'PRIVATE conversation' }] },
      identity,
    );
    rows.push(
      ...snapshots,
      request,
      cacheResponseTrace(request.sequence, { cacheRead: 16000, cacheWrite: 1000, cost: { total: 0.01 } }, runId),
    );
  }
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

test('pairs responses, resolves content-addressed versions, and does not expose text in summaries', () => {
  const trace = parseCacheTraceJsonl(fixture());
  expect(trace.requests).toHaveLength(3);
  expect(trace.snapshots.size).toBe(4);
  expect(trace.requests[1]).toMatchObject({
    cacheRead: 16000,
    cacheWrite: 1000,
    dollars: 0.01,
    system: { changed: true },
  });
  expect(renderCacheTraceSummary(trace.requests, trace.warnings)).toContain('CHANGED');
  expect(JSON.stringify(trace.requests)).not.toContain('SYSTEM');
  expect(diffTraceRequests(trace, trace.requests[0], trace.requests[1], 'system')).toContain(
    '-SYSTEM one\n+SYSTEM two',
  );
  expect(diffTraceRequests(trace, trace.requests[1], trace.requests[2], 'tools')).toContain('no text changes');
  expect(traceSnapshotText(trace, trace.requests[2], 'system')).toContain('SYSTEM two');
});

test('hash-only logs refuse text display with a useful instruction', () => {
  const trace = parseCacheTraceJsonl(fixture('hash'));
  expect(trace.snapshots.size).toBe(0);
  expect(() => traceSnapshotText(trace, trace.requests[0], 'system')).toThrow('enable system logging');
});

test('multiple runs/reloads and legacy sequence resets do not silently conflate requests', () => {
  const trace = parseCacheTraceJsonl(fixture('system', 'run1') + fixture('system', 'run2'));
  expect(() => selectTraceRequest(trace, 1)).toThrow('ambiguous');
  expect(selectTraceRequest(trace, 1, 'run2').runId).toBe('run2');
  const legacy = parseCacheTraceJsonl(
    '{"kind":"request","sequence":1}\n{"kind":"response","sequence":1,"cacheRead":12}\n{"kind":"request","sequence":1}\n',
  );
  expect(legacy.requests.map((row) => row.runId)).toEqual(['legacy-1', 'legacy-2']);
  expect(legacy.requests[0].cacheRead).toBe(12);
});

test('truncated tails are tolerated, malformed records and corrupt snapshots are rejected without echoing data', () => {
  const trace = parseCacheTraceJsonl(fixture() + '{"PRIVATE unfinished');
  expect(trace.warnings[0]).toContain('Trailing partial');
  expect(() => parseCacheTraceJsonl('PRIVATE bad\n')).toThrow('invalid JSON at line 1');
  expect(() => parseCacheTraceJsonl(fixture().replace('SYSTEM one', 'PRIVATE corrupt'))).toThrow('invalid snapshot');
  expect(parseCacheTraceJsonl('{"kind":"response","sequence":1}\n').warnings[0]).toContain('Unpaired');
});

test('raw snapshot display escapes C0/C1 terminal controls without corrupting the stored digest', () => {
  const tracer = createCacheTracer({ level: 'system', runId: 'control' });
  const escape = String.fromCharCode(27);
  const del = String.fromCharCode(127);
  const csi = String.fromCharCode(155);
  const { snapshots = [], ...request } = tracer(
    { instructions: `safe${escape}[31m${del}${csi}` },
    { provider: 'fixture', model: 'fixture' },
  );
  const trace = parseCacheTraceJsonl([...snapshots, request].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const displayed = traceSnapshotText(trace, trace.requests[0], 'system');
  expect(displayed).toContain('\\u001b');
  expect(displayed).toContain('\\u007f');
  expect(displayed).toContain('\\u009b');
  expect(displayed).not.toContain(escape);
});
