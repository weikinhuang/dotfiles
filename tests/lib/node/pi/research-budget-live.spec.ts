/**
 * Tests for lib/node/pi/research-budget-live.ts.
 *
 * LiveBudget wraps the pure RunBudget shape with live phase
 * observation (from PhaseEvent transitions) + trackers for the
 * cost hook + a final summary-journaling step. Spec drives a
 * fake clock and scripted PhaseEvents, then asserts the RunBudget
 * totals + journal output match.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { type PhaseEvent } from '../../../../lib/node/pi/deep-research-statusline.ts';
import {
  createLiveBudget,
  DEFAULT_BUDGET_PHASES,
  phaseEventToBudgetName,
} from '../../../../lib/node/pi/research-budget-live.ts';
import { createRunBudget } from '../../../../lib/node/pi/research-budget.ts';

const ALL_PHASES = DEFAULT_BUDGET_PHASES.map((p) => ({ ...p }));

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('phaseEventToBudgetName', () => {
  test('maps working phases to budget buckets', () => {
    expect(phaseEventToBudgetName('planning')).toBe('planner');
    expect(phaseEventToBudgetName('self-crit')).toBe('planner');
    expect(phaseEventToBudgetName('plan-crit')).toBe('plan-crit');
    expect(phaseEventToBudgetName('fanout-start')).toBe('fanout');
    expect(phaseEventToBudgetName('synth-start')).toBe('synth');
    expect(phaseEventToBudgetName('merge')).toBe('merge');
    expect(phaseEventToBudgetName('structural')).toBe('review');
    expect(phaseEventToBudgetName('subjective')).toBe('review');
  });

  test('returns null for non-mapping events', () => {
    expect(phaseEventToBudgetName('start')).toBeNull();
    expect(phaseEventToBudgetName('done')).toBeNull();
    expect(phaseEventToBudgetName('error')).toBeNull();
    expect(phaseEventToBudgetName('cost')).toBeNull();
    expect(phaseEventToBudgetName('fanout-progress')).toBeNull();
    expect(phaseEventToBudgetName('synth-progress')).toBeNull();
  });
});

describe('createLiveBudget', () => {
  test('routes addCost on currentPhaseTracker to the active phase', () => {
    const clock = fakeClock();
    const budget = createRunBudget(ALL_PHASES);
    const live = createLiveBudget({ budget, now: clock.now });

    live.observePhaseEvent({ kind: 'planning' });
    live.currentPhaseTracker.addCost(0.01);
    live.currentPhaseTracker.addCost(0.02);

    live.observePhaseEvent({ kind: 'fanout-start', total: 3 });
    live.currentPhaseTracker.addCost(0.1);

    expect(budget.perPhaseCostUsd.planner).toBeCloseTo(0.03, 6);
    expect(budget.perPhaseCostUsd.fanout).toBeCloseTo(0.1, 6);
    expect(budget.totalCostUsd).toBeCloseTo(0.13, 6);
  });

  test('tracks per-phase wall-clock on phase transitions', () => {
    const clock = fakeClock();
    const budget = createRunBudget(ALL_PHASES);
    const live = createLiveBudget({ budget, now: clock.now });

    live.observePhaseEvent({ kind: 'planning' }); // t = 0
    clock.advance(5_000); // 5s in planner
    live.observePhaseEvent({ kind: 'plan-crit' }); // closes planner (5s)
    clock.advance(3_000); // 3s in plan-crit
    live.observePhaseEvent({ kind: 'fanout-start', total: 3 }); // closes plan-crit (3s)
    clock.advance(12_000); // 12s in fanout
    live.observePhaseEvent({ kind: 'done' }); // closes fanout (12s)

    expect(budget.perPhaseWallClockSec.planner).toBeCloseTo(5, 3);
    expect(budget.perPhaseWallClockSec['plan-crit']).toBeCloseTo(3, 3);
    expect(budget.perPhaseWallClockSec.fanout).toBeCloseTo(12, 3);
    expect(budget.totalWallClockSec).toBeCloseTo(20, 3);
  });

  test('idempotent on repeated same-phase events (no double-start)', () => {
    const clock = fakeClock();
    const budget = createRunBudget(ALL_PHASES);
    const live = createLiveBudget({ budget, now: clock.now });

    live.observePhaseEvent({ kind: 'fanout-start', total: 3 });
    clock.advance(5_000);
    live.observePhaseEvent({ kind: 'fanout-start', total: 3 }); // duplicate - ignored
    live.observePhaseEvent({ kind: 'fanout-progress', done: 1 }); // non-mapping, ignored
    clock.advance(5_000);
    live.observePhaseEvent({ kind: 'done' });

    expect(budget.perPhaseWallClockSec.fanout).toBeCloseTo(10, 3);
  });

  test('currentPhaseTracker.addCost is a no-op when no phase is open', () => {
    const budget = createRunBudget(ALL_PHASES);
    const live = createLiveBudget({ budget });

    live.currentPhaseTracker.addCost(0.5); // no phase opened yet

    expect(budget.totalCostUsd).toBe(0);
  });

  test('trackerFor routes addCost to a named phase regardless of current phase', () => {
    const budget = createRunBudget(ALL_PHASES);
    const live = createLiveBudget({ budget });

    live.observePhaseEvent({ kind: 'planning' });
    const fanoutTracker = live.trackerFor('fanout');
    fanoutTracker.addCost(0.42);

    expect(budget.perPhaseCostUsd.fanout).toBeCloseTo(0.42, 6);
    expect(budget.perPhaseCostUsd.planner).toBeUndefined();
    expect(fanoutTracker.costUsd).toBeCloseTo(0.42, 6);
    expect(budget.totalCostUsd).toBeCloseTo(0.42, 6);
  });

  test('ignores NaN / negative / non-finite addCost values', () => {
    const budget = createRunBudget(ALL_PHASES);
    const live = createLiveBudget({ budget });

    live.observePhaseEvent({ kind: 'planning' });
    live.currentPhaseTracker.addCost(Number.NaN);
    live.currentPhaseTracker.addCost(-0.5);
    live.currentPhaseTracker.addCost(Number.POSITIVE_INFINITY);
    live.trackerFor('fanout').addCost(Number.NaN);

    expect(budget.totalCostUsd).toBe(0);
  });

  test('overrun warnings fire once per dimension when the phase closes past cap', () => {
    const clock = fakeClock();
    const dir = mkdtempSync(join(tmpdir(), 'live-budget-'));
    const journalPath = join(dir, 'journal.md');
    try {
      // Tight caps so cost *and* wall-clock both overrun easily.
      const budget = createRunBudget([
        { name: 'planner', maxCostUsd: 0.01, maxWallClockSec: 1 },
        { name: 'fanout', maxCostUsd: 10.0, maxWallClockSec: 10 },
      ]);
      const live = createLiveBudget({ budget, now: clock.now });
      live.setJournalPath(journalPath);

      live.observePhaseEvent({ kind: 'planning' });
      live.currentPhaseTracker.addCost(0.5); // overruns cost cap
      clock.advance(5_000); // overruns wall cap
      live.observePhaseEvent({ kind: 'fanout-start', total: 3 }); // closes planner → triggers both warnings
      clock.advance(1_000);
      live.observePhaseEvent({ kind: 'done' });

      const journal = readFileSync(journalPath, 'utf8');

      expect(journal).toMatch(/Phase "planner" exceeded cost cap/);
      expect(journal).toMatch(/Phase "planner" exceeded wall-clock cap/);
      // Each dimension appears exactly once.
      expect((journal.match(/exceeded cost cap/g) ?? []).length).toBe(1);
      expect((journal.match(/exceeded wall-clock cap/g) ?? []).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no overrun warning when a phase stays under its caps', () => {
    const clock = fakeClock();
    const dir = mkdtempSync(join(tmpdir(), 'live-budget-'));
    const journalPath = join(dir, 'journal.md');
    try {
      const budget = createRunBudget(ALL_PHASES);
      const live = createLiveBudget({ budget, now: clock.now });
      live.setJournalPath(journalPath);

      live.observePhaseEvent({ kind: 'planning' });
      live.currentPhaseTracker.addCost(0.01);
      clock.advance(1_000);
      live.observePhaseEvent({ kind: 'done' });

      // Summary goes to journal (via appendSummary below), but no
      // overrun warning should have fired before we call it.
      const journal = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '';

      expect(journal).not.toMatch(/exceeded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('appendSummary closes the current phase and writes per-phase + total line', () => {
    const clock = fakeClock();
    const dir = mkdtempSync(join(tmpdir(), 'live-budget-'));
    const journalPath = join(dir, 'journal.md');
    try {
      const budget = createRunBudget(ALL_PHASES);
      const live = createLiveBudget({ budget, now: clock.now });
      live.setJournalPath(journalPath);

      live.observePhaseEvent({ kind: 'planning' });
      live.currentPhaseTracker.addCost(0.02);
      clock.advance(2_000);
      live.observePhaseEvent({ kind: 'fanout-start', total: 2 });
      live.trackerFor('fanout').addCost(0.18);
      clock.advance(10_000);

      // Terminal event deliberately omitted - appendSummary must
      // close the open phase itself so a crashing pipeline still
      // gets a summary.
      live.appendSummary();

      const journal = readFileSync(journalPath, 'utf8');

      expect(journal).toMatch(/cost report/);
      expect(journal).toMatch(/phase=planner spent=0\.020000 USD wall=2\.00s/);
      expect(journal).toMatch(/phase=fanout spent=0\.180000 USD wall=10\.00s/);
      expect(journal).toMatch(/total=0\.200000 USD wall=12\.00s/);

      const snap = live.snapshot();

      expect(snap.currentPhase).toBeNull();
      expect(snap.totalCostUsd).toBeCloseTo(0.2, 6);
      expect(snap.totalWallClockSec).toBeCloseTo(12, 3);
      expect(snap.perPhase.planner).toEqual({ costUsd: 0.02, wallClockSec: 2 });
      expect(snap.perPhase.fanout.costUsd).toBeCloseTo(0.18, 6);
      expect(snap.perPhase.fanout.wallClockSec).toBeCloseTo(10, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('appendSummary is a no-op when no journal path is set', () => {
    const budget = createRunBudget(ALL_PHASES);
    const live = createLiveBudget({ budget });
    live.observePhaseEvent({ kind: 'planning' });
    live.currentPhaseTracker.addCost(0.01);

    // Must not throw even though journalPath is unset.
    expect(() => live.appendSummary()).not.toThrow();
  });

  test('snapshot reflects mid-run state (no terminal event required)', () => {
    const clock = fakeClock();
    const budget = createRunBudget(ALL_PHASES);
    const live = createLiveBudget({ budget, now: clock.now });

    live.observePhaseEvent({ kind: 'planning' });
    live.currentPhaseTracker.addCost(0.05);
    clock.advance(1_500);

    const snap = live.snapshot();

    expect(snap.currentPhase).toBe('planner');
    expect(snap.perPhase.planner.costUsd).toBeCloseTo(0.05, 6);
    // wallClock hasn't been committed yet (phase still open) - it's 0.
    expect(snap.perPhase.planner.wallClockSec).toBe(0);
    expect(snap.totalCostUsd).toBeCloseTo(0.05, 6);
  });

  test('script-style phase walk: planner → plan-crit → fanout → synth → merge → review → done', () => {
    const clock = fakeClock();
    const budget = createRunBudget(ALL_PHASES);
    const live = createLiveBudget({ budget, now: clock.now });

    const events: PhaseEvent[] = [
      { kind: 'start' },
      { kind: 'planning' },
      { kind: 'self-crit' },
      { kind: 'plan-crit' },
      { kind: 'fanout-start', total: 3 },
      { kind: 'synth-start', total: 3 },
      { kind: 'merge' },
      { kind: 'subjective', iteration: 1 },
      { kind: 'done' },
    ];

    for (const e of events) {
      live.observePhaseEvent(e);
      clock.advance(1_000);
      // Every phase that's actually open picks up a tiny cost.
      if (live.snapshot().currentPhase) live.currentPhaseTracker.addCost(0.01);
    }

    const snap = live.snapshot();

    expect(snap.currentPhase).toBeNull();
    expect(snap.perPhase.planner.costUsd).toBeCloseTo(0.02, 6); // planning + self-crit
    expect(snap.perPhase['plan-crit'].costUsd).toBeCloseTo(0.01, 6);
    expect(snap.perPhase.fanout.costUsd).toBeCloseTo(0.01, 6);
    expect(snap.perPhase.synth.costUsd).toBeCloseTo(0.01, 6);
    expect(snap.perPhase.merge.costUsd).toBeCloseTo(0.01, 6);
    expect(snap.perPhase.review.costUsd).toBeCloseTo(0.01, 6);
    expect(snap.totalCostUsd).toBeCloseTo(0.07, 6);
  });
});
