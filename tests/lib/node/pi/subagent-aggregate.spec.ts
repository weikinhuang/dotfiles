/**
 * Tests for lib/node/pi/subagent-aggregate.ts.
 *
 * Pure module - no pi runtime needed. Covers:
 *   - empty snapshot defaults
 *   - single + multi record summation
 *   - failure tracking separate from count
 *   - reset() returns to an empty snapshot
 *   - snapshot() returns a copy (mutating the result doesn't leak back)
 *   - getSessionSubagentAggregate() returns a process-wide singleton
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  __resetSessionSubagentAggregateForTests,
  getSessionSubagentAggregate,
  makeSubagentAggregate,
  type SubagentRunRecord,
} from '../../../../lib/node/pi/subagent-aggregate.ts';

function run(partial: Partial<SubagentRunRecord>): SubagentRunRecord {
  return {
    turns: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    cost: 0,
    durationMs: 0,
    failed: false,
    ...partial,
  };
}

describe('makeSubagentAggregate', () => {
  test('empty snapshot is all zeros', () => {
    const agg = makeSubagentAggregate();

    expect(agg.snapshot()).toEqual({
      count: 0,
      failures: 0,
      turns: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      cost: 0,
      totalDurationMs: 0,
    });
  });

  test('record sums token / cost / duration across runs', () => {
    const agg = makeSubagentAggregate();

    agg.record(run({ turns: 3, input: 100, cacheRead: 50, output: 20, cost: 0.02, durationMs: 1_000 }));
    agg.record(
      run({ turns: 5, input: 200, cacheRead: 400, cacheWrite: 10, output: 40, cost: 0.08, durationMs: 2_500 }),
    );

    expect(agg.snapshot()).toEqual({
      count: 2,
      failures: 0,
      turns: 8,
      input: 300,
      cacheRead: 450,
      cacheWrite: 10,
      output: 60,
      cost: 0.1,
      totalDurationMs: 3_500,
    });
  });

  test('failures count independently of total count', () => {
    const agg = makeSubagentAggregate();

    agg.record(run({ failed: false }));
    agg.record(run({ failed: true }));
    agg.record(run({ failed: true }));

    const s = agg.snapshot();

    expect(s.count).toBe(3);
    expect(s.failures).toBe(2);
  });

  test('reset returns to an empty snapshot', () => {
    const agg = makeSubagentAggregate();

    agg.record(run({ turns: 1, input: 10, cost: 0.01, failed: true }));
    agg.reset();

    expect(agg.snapshot()).toEqual({
      count: 0,
      failures: 0,
      turns: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      cost: 0,
      totalDurationMs: 0,
    });
  });

  test('snapshot returns a copy - mutating it does not leak back', () => {
    const agg = makeSubagentAggregate();

    agg.record(run({ turns: 2, input: 50 }));
    const s = agg.snapshot();
    s.turns = 9_999;
    s.input = 9_999;

    expect(agg.snapshot()).toMatchObject({ turns: 2, input: 50 });
  });
});

describe('getSessionSubagentAggregate', () => {
  afterEach(() => {
    __resetSessionSubagentAggregateForTests();
  });

  test('returns the same instance across calls in one process', () => {
    const a = getSessionSubagentAggregate();
    const b = getSessionSubagentAggregate();

    expect(a).toBe(b);
  });

  test('records written through one handle are visible through another', () => {
    const writer = getSessionSubagentAggregate();
    writer.record(run({ turns: 1, input: 7, output: 3, cost: 0.05 }));

    const reader = getSessionSubagentAggregate();

    expect(reader.snapshot()).toMatchObject({ count: 1, turns: 1, input: 7, output: 3, cost: 0.05 });
  });

  test('__resetSessionSubagentAggregateForTests drops the singleton so later calls see an empty state', () => {
    const first = getSessionSubagentAggregate();
    first.record(run({ turns: 1 }));

    __resetSessionSubagentAggregateForTests();

    const second = getSessionSubagentAggregate();

    expect(second).not.toBe(first);
    expect(second.snapshot().count).toBe(0);
  });

  test('two independently-evaluated copies of the module share one slot via globalThis', async () => {
    // Simulates pi's jiti loader, which creates a fresh module for
    // each extension. If we were still using a plain module-level
    // `let singleton`, each copy would get its own counter and the
    // subagent/statusline extensions would disagree. Using
    // `Symbol.for()` on `globalThis` must make the two copies share.
    __resetSessionSubagentAggregateForTests();
    vi.resetModules();
    const aMod = await import('../../../../lib/node/pi/subagent-aggregate.ts');
    vi.resetModules();
    const bMod = await import('../../../../lib/node/pi/subagent-aggregate.ts');

    expect(aMod).not.toBe(bMod);

    const fromA = aMod.getSessionSubagentAggregate();
    const fromB = bMod.getSessionSubagentAggregate();

    expect(fromB).toBe(fromA);

    fromA.record(run({ turns: 2, cost: 0.3 }));

    expect(fromB.snapshot()).toMatchObject({ count: 1, turns: 2, cost: 0.3 });
  });
});
