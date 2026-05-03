/**
 * Tests for `lib/node/pi/deep-research-statusline.ts`.
 *
 * Covers:
 *
 *   - initial state shape
 *   - each `PhaseEvent` kind's reduction
 *   - the full plan-to-done transition sequence referenced in the
 *     Phase-5 handoff (`planning → self-crit → plan-crit →
 *     fanout 3/6 → synth 2/6 → merge → structural → subjective`)
 *   - renderer output (elapsed, cost, label lines, terminal msg)
 *   - formatElapsed / formatCost helpers
 */

import { describe, expect, test } from 'vitest';

import {
  formatCost,
  formatElapsed,
  initialStatuslineState,
  type PhaseEvent,
  reduceAllStatusline,
  reduceStatusline,
  renderStatuslineWidget,
} from '../../../../lib/node/pi/deep-research-statusline.ts';

describe('deep-research-statusline initial state', () => {
  test('initialStatuslineState returns idle with zeroed counters', () => {
    const s = initialStatuslineState(1_700_000_000_000);

    expect(s.phase).toBe('idle');
    expect(s.label).toBe('idle');
    expect(s.startedAt).toBe(1_700_000_000_000);
    expect(s.costUsd).toBe(0);
    expect(s.fanout).toEqual({ done: 0, total: 0 });
    expect(s.synth).toEqual({ done: 0, total: 0 });
    expect(s.reviewIter).toBe(0);
    expect(s.message).toBeUndefined();
  });
});

describe('reduceStatusline per-event transitions', () => {
  const baseline = initialStatuslineState(1_700_000_000_000);

  test('start resets counters but keeps the epoch anchor', () => {
    const dirty = reduceStatusline(baseline, { kind: 'fanout-start', total: 3 });
    const afterStart = reduceStatusline(dirty, { kind: 'start' });

    expect(afterStart.phase).toBe('idle');
    expect(afterStart.label).toBe('idle');
    expect(afterStart.fanout).toEqual({ done: 0, total: 0 });
    expect(afterStart.startedAt).toBe(baseline.startedAt);
  });

  test('planning / self-crit / plan-crit set the expected labels', () => {
    expect(reduceStatusline(baseline, { kind: 'planning' }).label).toBe('planning');
    expect(reduceStatusline(baseline, { kind: 'self-crit' }).label).toBe('self-crit');
    expect(reduceStatusline(baseline, { kind: 'plan-crit' }).label).toBe('plan-crit');
  });

  test('fanout-start initializes totals and label to `fanout 0/N`', () => {
    const s = reduceStatusline(baseline, { kind: 'fanout-start', total: 6 });

    expect(s.phase).toBe('fanout');
    expect(s.label).toBe('fanout 0/6');
    expect(s.fanout).toEqual({ done: 0, total: 6 });
  });

  test('fanout-progress carries the done counter into the label', () => {
    let s = reduceStatusline(baseline, { kind: 'fanout-start', total: 6 });
    s = reduceStatusline(s, { kind: 'fanout-progress', done: 3 });

    expect(s.label).toBe('fanout 3/6');
    expect(s.fanout).toEqual({ done: 3, total: 6 });
  });

  test('fanout-progress inherits total when omitted and clamps done to total', () => {
    let s = reduceStatusline(baseline, { kind: 'fanout-start', total: 4 });
    s = reduceStatusline(s, { kind: 'fanout-progress', done: 9 });

    expect(s.fanout).toEqual({ done: 9, total: 9 });
    // Expanded to accommodate overflow rather than silently losing it.
    expect(s.label).toBe('fanout 9/9');
  });

  test('synth-start / synth-progress mirror fanout semantics', () => {
    let s = reduceStatusline(baseline, { kind: 'synth-start', total: 6 });

    expect(s.label).toBe('synth 0/6');

    s = reduceStatusline(s, { kind: 'synth-progress', done: 2 });

    expect(s.label).toBe('synth 2/6');
    expect(s.phase).toBe('synth');
  });

  test('merge sets the merge label without altering counters', () => {
    let s = reduceStatusline(baseline, { kind: 'synth-start', total: 3 });
    s = reduceStatusline(s, { kind: 'synth-progress', done: 3 });
    s = reduceStatusline(s, { kind: 'merge' });

    expect(s.phase).toBe('merge');
    expect(s.label).toBe('merge');
    expect(s.synth).toEqual({ done: 3, total: 3 });
  });

  test('structural / subjective carry iteration numbers in the label', () => {
    const s1 = reduceStatusline(baseline, { kind: 'structural', iteration: 2 });

    expect(s1.phase).toBe('structural');
    expect(s1.label).toBe('structural (iter 2)');
    expect(s1.reviewIter).toBe(2);

    const s2 = reduceStatusline(s1, { kind: 'subjective', iteration: 2 });

    expect(s2.phase).toBe('subjective');
    expect(s2.label).toBe('subjective (iter 2)');
    expect(s2.reviewIter).toBe(2);
  });

  test('cost events accumulate; negatives clamp to zero', () => {
    let s = reduceStatusline(baseline, { kind: 'cost', deltaUsd: 0.25 });

    expect(s.costUsd).toBeCloseTo(0.25, 6);

    s = reduceStatusline(s, { kind: 'cost', deltaUsd: 0.1 });

    expect(s.costUsd).toBeCloseTo(0.35, 6);

    s = reduceStatusline(s, { kind: 'cost', deltaUsd: -100 });

    expect(s.costUsd).toBe(0);
  });

  test('done and error set terminal state + message', () => {
    const d = reduceStatusline(baseline, { kind: 'done', message: 'report ok' });

    expect(d.phase).toBe('done');
    expect(d.label).toBe('done');
    expect(d.message).toBe('report ok');

    const e = reduceStatusline(baseline, { kind: 'error', message: 'boom' });

    expect(e.phase).toBe('error');
    expect(e.label).toBe('error');
    expect(e.message).toBe('boom');
  });
});

describe('reduceAllStatusline plan-to-done sequence', () => {
  test('drives through every phase boundary the plan promises', () => {
    const events: PhaseEvent[] = [
      { kind: 'start' },
      { kind: 'planning' },
      { kind: 'self-crit' },
      { kind: 'plan-crit' },
      { kind: 'fanout-start', total: 6 },
      { kind: 'fanout-progress', done: 1 },
      { kind: 'fanout-progress', done: 2 },
      { kind: 'fanout-progress', done: 3 },
      { kind: 'fanout-progress', done: 6 },
      { kind: 'synth-start', total: 6 },
      { kind: 'synth-progress', done: 1 },
      { kind: 'synth-progress', done: 2 },
      { kind: 'merge' },
      { kind: 'structural', iteration: 1 },
      { kind: 'subjective', iteration: 1 },
      { kind: 'done', message: 'review passed' },
    ];
    const labels: string[] = [];
    let state = initialStatuslineState(1_700_000_000_000);
    for (const e of events) {
      state = reduceStatusline(state, e);
      labels.push(state.label);
    }

    expect(labels).toEqual([
      'idle',
      'planning',
      'self-crit',
      'plan-crit',
      'fanout 0/6',
      'fanout 1/6',
      'fanout 2/6',
      'fanout 3/6',
      'fanout 6/6',
      'synth 0/6',
      'synth 1/6',
      'synth 2/6',
      'merge',
      'structural (iter 1)',
      'subjective (iter 1)',
      'done',
    ]);

    const batch = reduceAllStatusline(events, initialStatuslineState(1_700_000_000_000));

    expect(batch.label).toBe('done');
    expect(batch.phase).toBe('done');
    expect(batch.message).toBe('review passed');
  });
});

describe('renderStatuslineWidget', () => {
  test('two lines in the common case; elapsed + cost on line 2', () => {
    const s = reduceStatusline(initialStatuslineState(0), { kind: 'fanout-start', total: 6 });
    const lines = renderStatuslineWidget(s, 65_000); // 1m 05s elapsed

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('deep-research: fanout 0/6');
    expect(lines[1]).toBe('  elapsed 1m 05s · cost $0.000');
  });

  test('terminal states append the message line', () => {
    const s = reduceStatusline(initialStatuslineState(0), {
      kind: 'done',
      message: 'report ready at ./report.md',
    });
    const lines = renderStatuslineWidget(s, 42_000);

    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('  report ready at ./report.md');
  });

  test('cost updates land on line 2', () => {
    let s = reduceStatusline(initialStatuslineState(0), { kind: 'planning' });
    s = reduceStatusline(s, { kind: 'cost', deltaUsd: 1.234 });
    const lines = renderStatuslineWidget(s, 10_000);

    expect(lines[1]).toBe('  elapsed 10s · cost $1.234');
  });
});

describe('formatters', () => {
  test('formatElapsed produces compact strings', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(1_500)).toBe('1s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(3_723_000)).toBe('1h 02m 03s');
  });

  test('formatCost always emits 3-decimal USD with a dollar sign', () => {
    expect(formatCost(0)).toBe('$0.000');
    expect(formatCost(0.5)).toBe('$0.500');
    expect(formatCost(-1)).toBe('$0.000');
    expect(formatCost(12.3456)).toBe('$12.346');
  });
});
