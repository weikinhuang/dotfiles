/**
 * Tests for lib/node/opencode/cost-guard.ts.
 */

import { expect, test } from 'vitest';

import {
  buildUpdateEvent,
  contextUsageRecords,
  createCostGuardTracker,
  estimateWriteDollars,
  formatLogLine,
  modelIdentity,
  opencodeCostSample,
  parseStatusInput,
  parseStatusOutput,
  parseUpdateEvent,
  type PriceTier,
  resolveOpencodeCostGuardConfig,
  statusLabel,
  type UsageRecord,
} from '../../../../lib/node/opencode/cost-guard.ts';

const HAIKU = { providerID: 'github-copilot', id: 'claude-haiku-5.5' };
const PRICES: PriceTier[] = [{ input: 1, output: 5, cache: { read: 0.1, write: 1.25 } }];

const config = resolveOpencodeCostGuardConfig({}, {}).guard;

function tokens(read: number, write: number, input = 10): unknown {
  return { input, output: 20, reasoning: 0, cache: { read, write } };
}

function step(id: string, dollars: number, read = 1000, write = 100): UsageRecord {
  const sample = opencodeCostSample(dollars, tokens(read, write), PRICES);
  if (!sample) throw new Error('sample');
  return { messageID: id, identity: modelIdentity(HAIKU), assistant: true, sample };
}

function nested(dollars: number): UsageRecord {
  const sample = opencodeCostSample(dollars, tokens(0, 0));
  if (!sample) throw new Error('sample');
  return { assistant: false, sample };
}

test('resolveOpencodeCostGuardConfig: defaults match pi', () => {
  expect(resolveOpencodeCostGuardConfig(undefined, {})).toEqual({
    enabled: true,
    log: undefined,
    guard: {
      window: 4,
      readTolerance: 0.02,
      writeContextRatio: 0.5,
      writeCostRatio: 0.7,
      callDollars: 0.25,
      milestones: [2, 5, 10],
    },
  });
});

test('resolveOpencodeCostGuardConfig: options, env precedence, and milestone forms', () => {
  const resolved = resolveOpencodeCostGuardConfig(
    { window: 6, callDollars: 0.00001, milestones: [5, 1], writeCostRatio: '0', log: '/tmp/cg.log' },
    { OPENCODE_COST_GUARD_WINDOW: '3', OPENCODE_COST_GUARD_ENABLED: 'off' },
  );
  expect(resolved.enabled).toBe(false);
  expect(resolved.log).toBe('/tmp/cg.log');
  expect(resolved.guard).toMatchObject({ window: 3, callDollars: 0.00001, milestones: [1, 5], writeCostRatio: 0 });
  expect(resolveOpencodeCostGuardConfig({ milestones: [] }, {}).guard.milestones).toEqual([]);
  expect(resolveOpencodeCostGuardConfig({ milestones: false }, {}).guard.milestones).toEqual([]);
  expect(resolveOpencodeCostGuardConfig({}, { OPENCODE_COST_GUARD_MILESTONES: '3,1' }).guard.milestones).toEqual([
    1, 3,
  ]);
  // Out-of-range values fall back to the default (pi bounds).
  expect(resolveOpencodeCostGuardConfig({ readTolerance: 2, window: 1000 }, {}).guard).toMatchObject({
    readTolerance: 0.02,
    window: 100,
  });
});

test('opencodeCostSample: maps tokens + cost, context excludes output', () => {
  expect(opencodeCostSample(0.5, tokens(300, 100, 20))).toEqual({
    read: 300,
    write: 100,
    context: 420,
    dollars: 0.5,
    writeDollars: 0,
  });
  expect(opencodeCostSample(0.5, undefined)).toBeUndefined();
  expect(opencodeCostSample(Number.NaN, { input: -1, cache: { read: 'x' } })).toEqual({
    read: 0,
    write: 0,
    context: 0,
    dollars: 0,
    writeDollars: 0,
  });
});

test('estimateWriteDollars: apportions the step cost by catalog price split', () => {
  const usage = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 1000 } };
  expect(estimateWriteDollars(0.01, usage, PRICES)).toBeCloseTo(0.01);
  const mixed = { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 1000 } };
  // write 1.25 vs input 1 per million -> 5/9 of the cost.
  expect(estimateWriteDollars(0.009, mixed, PRICES)).toBeCloseTo(0.005);
  expect(estimateWriteDollars(0.009, mixed, undefined)).toBe(0);
  expect(estimateWriteDollars(0, mixed, PRICES)).toBe(0);
  // Context tiers: the largest exceeded tier wins.
  const tiered: PriceTier[] = [
    { input: 1, output: 1, cache: { read: 0, write: 0 } },
    { tier: { type: 'context', size: 500 }, input: 1, output: 1, cache: { read: 0, write: 3 } },
  ];
  expect(estimateWriteDollars(0.004, mixed, tiered)).toBeCloseTo(0.003);
});

test('modelIdentity: provider + model id only', () => {
  expect(modelIdentity({ ...HAIKU, variant: 'high' })).toBe('["github-copilot","claude-haiku-5.5"]');
  expect(modelIdentity({ id: 'x' })).toBeUndefined();
});

test('contextUsageRecords: assistant steps feed the window, compactions are nested, the rest is ignored', () => {
  const records = contextUsageRecords(
    [
      { id: 'u1', type: 'user', text: 'hi' },
      { id: 'a1', type: 'assistant', model: HAIKU, cost: 0.1, tokens: tokens(10, 5) },
      { id: 'a2', type: 'assistant', model: HAIKU },
      { id: 'c1', type: 'compaction', status: 'completed', cost: 0.2, tokens: tokens(0, 0) },
      null,
    ],
    () => PRICES,
  );
  expect(records.map((record) => [record.messageID, record.assistant, record.sample.dollars])).toEqual([
    ['a1', true, 0.1],
    ['c1', false, 0.2],
  ]);
  expect(records[0].identity).toBe(modelIdentity(HAIKU));
  expect(records[0].sample.writeDollars).toBeGreaterThan(0);
});

test('tracker: one combined notice per response, deduped per episode, rearmed after healthy calls', () => {
  const tracker = createCostGuardTracker({ ...config, callDollars: 0.1, milestones: [0.25] });
  const first = tracker.observe('root', step('a1', 0.2));
  expect(first?.notices.map((notice) => notice.id)).toEqual(['call']);
  expect(first?.statusChanged).toBe(true);
  const second = tracker.observe('root', step('a2', 0.2));
  // Same condition deduped; the milestone crossing is the only new notice.
  expect(second?.notices.map((notice) => notice.id)).toEqual(['budget:0.25']);
  expect(second?.statusChanged).toBe(false);
  expect(tracker.observe('root', step('a3', 0.2))?.notices).toEqual([]);
  for (const id of ['h1', 'h2', 'h3', 'h4']) tracker.observe('root', step(id, 0.01, 10_000 + id.length, 100));
  expect(tracker.snapshot('root')?.status).toBe('ok');
  expect(tracker.observe('root', step('a4', 0.2))?.notices.map((notice) => notice.id)).toEqual(['call']);
});

test('tracker: child usage adds spend but never enters the window or trips the per-call check', () => {
  const tracker = createCostGuardTracker({ ...config, callDollars: 0.1, milestones: [1] });
  const update = tracker.observe('root', nested(0.5));
  expect(update?.notices).toEqual([]);
  expect(update?.totalDollars).toBe(0.5);
  expect(tracker.observe('root', nested(0.6))?.notices.map((notice) => notice.id)).toEqual(['budget:1']);
  // The window is still empty: four healthy root calls stay silent.
  for (const id of ['a1', 'a2', 'a3']) expect(tracker.observe('root', step(id, 0.01))?.notices).toEqual([]);
});

test('tracker: seed replays silently, marks milestones and episodes, and skips replayed live events', () => {
  const tracker = createCostGuardTracker({ ...config, callDollars: 0.1, milestones: [0.3, 5] });
  tracker.seed('root', {
    records: [step('a1', 0.2), step('a2', 0.2), step('t', 0.2)],
    sessionDollars: 1.2,
    exclude: { messageID: 't', dollars: 0.2 },
  });
  // Session totals (title / children) win over the replayed sum; the trigger's dollars are left out.
  expect(tracker.snapshot('root')).toEqual({ status: 'warning', totalDollars: 1 });
  // A replayed message arriving live is dropped.
  expect(tracker.observe('root', step('a2', 0.2))).toBeUndefined();
  // The trigger is observed live: its episode and milestone were already marked, so no notices, but the
  // first update after a seed reports the status once.
  const trigger = tracker.observe('root', step('t', 0.2));
  expect(trigger?.notices).toEqual([]);
  expect(trigger?.statusChanged).toBe(true);
  expect(trigger?.totalDollars).toBeCloseTo(1.2);
  expect(tracker.observe('root', step('a3', 0.2))?.statusChanged).toBe(false);
});

test('tracker: seeding a fresh session leaves the trigger to warn live', () => {
  const tracker = createCostGuardTracker({ ...config, callDollars: 0.1 });
  tracker.seed('root', { records: [step('t', 0.2)], sessionDollars: 0.2, exclude: { messageID: 't', dollars: 0.2 } });
  expect(tracker.snapshot('root')).toEqual({ status: 'ok', totalDollars: 0 });
  expect(tracker.observe('root', step('t', 0.2))?.notices.map((notice) => notice.id)).toEqual(['call']);
});

test('tracker: resetWindow clears episodes but keeps spend; forget drops the session', () => {
  const tracker = createCostGuardTracker({ ...config, callDollars: 0.1 });
  expect(tracker.resetWindow('root')).toBeUndefined();
  tracker.observe('root', step('a1', 0.2));
  const reset = tracker.resetWindow('root');
  expect(reset).toMatchObject({ status: 'ok', statusChanged: true, notices: [] });
  expect(reset?.totalDollars).toBeCloseTo(0.2);
  expect(tracker.observe('root', step('a2', 0.2))?.notices.map((notice) => notice.id)).toEqual(['call']);
  tracker.forget('root');
  expect(tracker.has('root')).toBe(false);
});

test('buildUpdateEvent / parseUpdateEvent: round trip, silent when nothing changed', () => {
  const tracker = createCostGuardTracker({ ...config, callDollars: 0.1 });
  const update = tracker.observe('root', step('a1', 0.2));
  if (!update) throw new Error('update');
  const event = buildUpdateEvent('root', update);
  expect(event).toMatchObject({ sessionID: 'root', status: 'warning', variant: 'warning' });
  expect(event?.message).toMatch(/^Cost guard: one call cost \$0\.20/);
  expect(parseUpdateEvent({ ...event })).toEqual(event);
  expect(buildUpdateEvent('root', { notices: [], status: 'warning', statusChanged: false, totalDollars: 1 })).toBe(
    undefined,
  );
  expect(buildUpdateEvent('root', { notices: [], status: 'ok', statusChanged: true, totalDollars: 1 })).toEqual({
    sessionID: 'root',
    status: 'ok',
    totalDollars: 1,
  });
  const critical = buildUpdateEvent('root', {
    notices: [{ id: 'plateau', severity: 'critical', text: 'frozen' }],
    status: 'critical',
    statusChanged: true,
    totalDollars: 1,
  });
  expect(critical?.variant).toBe('error');
  expect(parseUpdateEvent({ sessionID: 'x', status: 'bad' })).toBeUndefined();
  expect(parseUpdateEvent('nope')).toBeUndefined();
});

test('status RPC helpers and labels', () => {
  expect(parseStatusInput({ sessionID: 's' })).toBe('s');
  expect(parseStatusInput({ sessionID: '' })).toBeUndefined();
  expect(parseStatusOutput({ sessionID: 's', known: true, status: 'critical', totalDollars: 2 })).toEqual({
    sessionID: 's',
    known: true,
    status: 'critical',
    totalDollars: 2,
  });
  expect(parseStatusOutput({ sessionID: 's', status: 'x' })).toBeUndefined();
  expect(statusLabel('critical')).toBe('cost:critical');
  expect(statusLabel('ok')).toBeUndefined();
  expect(statusLabel(undefined)).toBeUndefined();
  expect(
    formatLogLine(new Date(0), { sessionID: 's', status: 'warning', totalDollars: 0.5, message: 'Cost guard: x.' }),
  ).toBe('1970-01-01T00:00:00.000Z session=s status=warning total=$0.5000 Cost guard: x.');
});
