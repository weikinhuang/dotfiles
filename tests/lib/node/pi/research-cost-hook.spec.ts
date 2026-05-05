/**
 * Tests for lib/node/pi/research-cost-hook.ts.
 *
 * The hook is pure: given a scripted stream of events with or
 * without `message.usage.cost.total`, confirm the three sinks
 * (statusline emit, PhaseTracker.addCost, journal append) fire
 * exactly when they should.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { type PhaseEvent } from '../../../../lib/node/pi/deep-research-statusline.ts';
import { createCostHook, type CostEventLike } from '../../../../lib/node/pi/research-cost-hook.ts';

function assistantMessageEnd(totalUsd: number): CostEventLike {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      usage: { cost: { total: totalUsd } },
    },
  };
}

describe('createCostHook', () => {
  test('routes assistant message_end cost to emit + tracker + journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-hook-'));
    const journalPath = join(dir, 'journal.md');
    try {
      const emitted: PhaseEvent[] = [];
      const trackerCalls: number[] = [];
      const hook = createCostHook({
        emit: (e) => emitted.push(e),
        tracker: { addCost: (n) => trackerCalls.push(n) },
        journalPath,
        phase: 'planner',
      });

      hook.subscribe(assistantMessageEnd(0.0125));

      expect(emitted).toEqual([{ kind: 'cost', deltaUsd: 0.0125 }]);
      expect(trackerCalls).toEqual([0.0125]);
      expect(hook.totalUsd).toBeCloseTo(0.0125, 6);

      const journal = readFileSync(journalPath, 'utf8');

      expect(journal).toMatch(/\[step\] cost delta · planner · 0\.012500 USD/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('onEvent wrapper unwraps runOneShotAgent event payload', () => {
    const emitted: PhaseEvent[] = [];
    const hook = createCostHook({ emit: (e) => emitted.push(e) });

    // Shape matches runOneShotAgent's `{event, turn, abort}` wrapper;
    // the hook ignores everything but `event`.
    hook.onEvent({ event: assistantMessageEnd(0.01) });

    expect(emitted).toEqual([{ kind: 'cost', deltaUsd: 0.01 }]);
    expect(hook.totalUsd).toBeCloseTo(0.01, 6);
  });

  test('ignores non-message_end events', () => {
    const emitted: PhaseEvent[] = [];
    const hook = createCostHook({ emit: (e) => emitted.push(e) });

    hook.subscribe({ type: 'turn_end', message: { role: 'assistant', usage: { cost: { total: 99 } } } });
    hook.subscribe({ type: 'message_update', message: { role: 'assistant', usage: { cost: { total: 99 } } } });

    expect(emitted).toEqual([]);
    expect(hook.totalUsd).toBe(0);
  });

  test('ignores non-assistant roles (tool / user / missing)', () => {
    const emitted: PhaseEvent[] = [];
    const hook = createCostHook({ emit: (e) => emitted.push(e) });

    hook.subscribe({ type: 'message_end', message: { role: 'user', usage: { cost: { total: 5 } } } });
    hook.subscribe({ type: 'message_end', message: { role: 'tool', usage: { cost: { total: 5 } } } });
    hook.subscribe({ type: 'message_end', message: { usage: { cost: { total: 5 } } } });

    expect(emitted).toEqual([]);
    expect(hook.totalUsd).toBe(0);
  });

  test('ignores missing / non-finite / non-positive totals', () => {
    const emitted: PhaseEvent[] = [];
    const hook = createCostHook({ emit: (e) => emitted.push(e) });

    // missing usage
    hook.subscribe({ type: 'message_end', message: { role: 'assistant' } });
    // missing cost
    hook.subscribe({ type: 'message_end', message: { role: 'assistant', usage: {} } });
    // total undefined
    hook.subscribe({ type: 'message_end', message: { role: 'assistant', usage: { cost: {} } } });
    // total NaN / Infinity / negative / zero
    hook.subscribe(assistantMessageEnd(Number.NaN));
    hook.subscribe(assistantMessageEnd(Number.POSITIVE_INFINITY));
    hook.subscribe(assistantMessageEnd(-0.01));
    hook.subscribe(assistantMessageEnd(0));

    expect(emitted).toEqual([]);
    expect(hook.totalUsd).toBe(0);
  });

  test('accumulates across multiple assistant turns', () => {
    const emitted: PhaseEvent[] = [];
    const trackerCalls: number[] = [];
    const hook = createCostHook({
      emit: (e) => emitted.push(e),
      tracker: { addCost: (n) => trackerCalls.push(n) },
    });

    hook.subscribe(assistantMessageEnd(0.01));
    hook.subscribe(assistantMessageEnd(0.02));
    hook.subscribe(assistantMessageEnd(0.03));

    expect(emitted).toEqual([
      { kind: 'cost', deltaUsd: 0.01 },
      { kind: 'cost', deltaUsd: 0.02 },
      { kind: 'cost', deltaUsd: 0.03 },
    ]);
    expect(trackerCalls).toEqual([0.01, 0.02, 0.03]);
    expect(hook.totalUsd).toBeCloseTo(0.06, 6);
  });

  test('sink throws are swallowed and do not abort the hook', () => {
    const hook = createCostHook({
      emit: () => {
        throw new Error('emit boom');
      },
      tracker: {
        addCost: () => {
          throw new Error('tracker boom');
        },
      },
    });

    expect(() => hook.subscribe(assistantMessageEnd(0.01))).not.toThrow();
    expect(hook.totalUsd).toBeCloseTo(0.01, 6);
  });

  test('works with no sinks at all (pure counter)', () => {
    const hook = createCostHook();
    hook.subscribe(assistantMessageEnd(0.05));
    hook.subscribe(assistantMessageEnd(0.05));

    expect(hook.totalUsd).toBeCloseTo(0.1, 6);
  });

  test('journalPath without phase falls back to "unknown"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-hook-'));
    const journalPath = join(dir, 'journal.md');
    try {
      const hook = createCostHook({ journalPath });
      hook.subscribe(assistantMessageEnd(0.001));
      const journal = readFileSync(journalPath, 'utf8');

      expect(journal).toMatch(/cost delta · unknown · 0\.001000 USD/);
      expect(hook.totalUsd).toBeCloseTo(0.001, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('journal entries suppressed when minDeltaUsd is above the per-turn cost, but total still accumulates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-hook-'));
    const journalPath = join(dir, 'journal.md');
    try {
      const hook = createCostHook({
        journalPath,
        phase: 'noisy',
        minDeltaUsd: 0.01,
      });

      hook.subscribe(assistantMessageEnd(0.0001)); // below threshold, no journal
      hook.subscribe(assistantMessageEnd(0.05)); // above threshold, journaled

      expect(hook.totalUsd).toBeCloseTo(0.0501, 6);
      expect(existsSync(journalPath)).toBe(true);

      const journal = readFileSync(journalPath, 'utf8');
      const occurrences = journal.match(/cost delta · noisy/g) ?? [];

      expect(occurrences.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('journalLevel override', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cost-hook-'));
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test('defaults to "step"', () => {
      const journalPath = join(dir, 'journal.md');
      const hook = createCostHook({ journalPath, phase: 'p' });
      hook.subscribe(assistantMessageEnd(0.01));

      expect(readFileSync(journalPath, 'utf8')).toMatch(/\[step\] cost delta · p/);
    });

    test('caller can request "warn"', () => {
      const journalPath = join(dir, 'journal.md');
      const hook = createCostHook({ journalPath, phase: 'p', journalLevel: 'warn' });
      hook.subscribe(assistantMessageEnd(0.01));

      expect(readFileSync(journalPath, 'utf8')).toMatch(/\[warn\] cost delta · p/);
    });
  });
});
