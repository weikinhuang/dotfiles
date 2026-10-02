import { expect, test } from 'vitest';

import {
  costGuardConfig,
  costSample,
  createCostGuardState,
  enabledAutoInjectors,
  guardNotification,
  guardStatus,
  guardUsageRecords,
  observeCostSample,
  reconcileGuardAccounting,
  type CostSample,
} from '../../../../lib/node/pi/cost-guard.ts';
import { piCacheIncident } from '../../../fixtures/pi-cache-incident.ts';

const config = costGuardConfig({});
const bad = (index: number): CostSample => ({
  read: 16816,
  write: 86410 + index * 2000,
  context: 103226 + index * 2000,
  dollars: 0.45,
  writeDollars: 0.43,
});
const healthy = (index: number): CostSample => ({
  read: 100000 + index * 10000,
  write: 1000,
  context: 101000 + index * 10000,
  dollars: 0.001,
  writeDollars: 0.0001,
});

test('incident plateau is detected within four bad calls, including the lower-write 64k plateau', () => {
  const records = guardUsageRecords(piCacheIncident());
  for (const start of [8, 28]) {
    const state = createCostGuardState();
    let found = false;
    for (const record of records.slice(start, start + 4)) {
      const notices = observeCostSample(state, costSample(record.usage), config, record.identity);
      if (notices.some((notice) => notice.id === 'plateau')) found = true;
    }
    expect(found).toBe(true);
    expect(guardStatus(state)).toBe('critical');
  }
});

test('healthy advancing cache stays silent and retains only the bounded window', () => {
  const state = createCostGuardState();
  for (let index = 0; index < 100; index++)
    expect(observeCostSample(state, healthy(index), config, 'model')).toEqual([]);
  expect(state.samples).toHaveLength(4);
  expect(guardStatus(state)).toBeUndefined();
});

test('persistent bad series deduplicates by condition and milestone, not by turn', () => {
  const state = createCostGuardState();
  const ids: string[] = [];
  for (let index = 0; index < 30; index++)
    ids.push(...observeCostSample(state, bad(index), config, 'model').map((notice) => notice.id));
  expect(ids.filter((id) => id === 'plateau')).toHaveLength(1);
  expect(ids.filter((id) => id === 'rewrite')).toHaveLength(1);
  expect(ids.filter((id) => id === 'call')).toHaveLength(1);
  expect(ids.filter((id) => id === 'budget:2')).toHaveLength(1);
  expect(ids.filter((id) => id === 'budget:5')).toHaveLength(1);
  expect(ids.filter((id) => id === 'budget:10')).toHaveLength(1);
});

test('recovery rearms transient alerts; model changes reset the window without losing actual spend', () => {
  const state = createCostGuardState();
  const quiet = { ...config, writeCostRatio: 0, milestones: [] };
  for (let index = 0; index < 4; index++) observeCostSample(state, bad(index), quiet, 'model');
  for (let index = 0; index < 8; index++) observeCostSample(state, healthy(index), quiet, 'model');
  expect(guardStatus(state)).toBeUndefined();
  let fired = false;
  for (let index = 0; index < 4; index++)
    if (observeCostSample(state, bad(index), quiet, 'model').some((notice) => notice.id === 'plateau')) fired = true;
  expect(fired).toBe(true);
  const spend = state.totalDollars;
  observeCostSample(state, healthy(0), quiet, 'other');
  expect(state.samples).toHaveLength(1);
  expect(state.totalDollars).toBeGreaterThan(spend);
  expect(createCostGuardState().totalDollars).toBe(0);
});

test('thresholds validate and individual conditions can be disabled', () => {
  expect(
    costGuardConfig({
      PI_COST_GUARD_WINDOW: '1000',
      PI_COST_GUARD_READ_TOLERANCE: 'Infinity',
      PI_COST_GUARD_CALL_DOLLARS: '-1',
      PI_COST_GUARD_MILESTONES: '5,2,5',
    }),
  ).toMatchObject({ window: 100, readTolerance: 0.02, callDollars: 0.25, milestones: [2, 5] });
  const custom = costGuardConfig({
    PI_COST_GUARD_READ_TOLERANCE: '0',
    PI_COST_GUARD_CALL_DOLLARS: '0',
    PI_COST_GUARD_WRITE_COST_RATIO: '0',
    PI_COST_GUARD_WRITE_CONTEXT_RATIO: '0',
    PI_COST_GUARD_MILESTONES: 'none',
  });
  expect(custom.milestones).toEqual([]);
  expect(observeCostSample(createCostGuardState(), bad(0), custom, 'model')).toEqual([]);
});

test('usage parsing ignores nonfinite/negative fields and excludes output from prompt size', () => {
  expect(
    costSample({ input: 2, output: 90000, cacheRead: 3, cacheWrite: 5, cost: { total: 0.2, cacheWrite: 0.1 } }),
  ).toEqual({ read: 3, write: 5, context: 10, dollars: 0.2, writeDollars: 0.1 });
  expect(costSample({ input: NaN, cacheRead: Infinity, cacheWrite: -5, cost: { total: NaN } }).context).toBe(0);
  expect(costSample(null).dollars).toBe(0);
});

test('nested/compaction accounting affects session dollars, not the assistant window', () => {
  const entries = [
    { type: 'message', message: { role: 'toolResult', usage: { cost: { total: 0.5 } } } },
    { type: 'compaction', usage: { cost: { total: 0.3 } } },
    { type: 'usage', usage: { cost: { total: 0.1 } } },
  ];
  const state = createCostGuardState();
  for (const record of guardUsageRecords(entries))
    observeCostSample(state, costSample(record.usage), config, record.identity, record.assistant);
  expect(state.totalDollars).toBeCloseTo(0.9);
  expect(state.samples).toHaveLength(0);
  expect(guardUsageRecords([null, {}, { type: 'message', message: null }])).toEqual([]);
  reconcileGuardAccounting(state, entries);
  expect(state.totalDollars).toBeCloseTo(0.9);
});

test('notification text names enabled injectors without modifying model context or configuration', () => {
  const env = { PI_TODO_DISABLE_AUTOINJECT: 'yes' };
  const enabled = enabledAutoInjectors(env, ['todo', 'bg_bash', 'memory']);
  expect(enabled).toEqual(['bg_bash', 'memory']);
  const message = guardNotification([{ id: 'plateau', severity: 'critical', text: 'frozen' }], enabled);
  expect(message).toContain('Start a fresh session or compact');
  expect(message).toContain('bg_bash, memory');
  expect(env).toEqual({ PI_TODO_DISABLE_AUTOINJECT: 'yes' });
});
