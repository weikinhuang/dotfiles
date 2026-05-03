/**
 * Tests for lib/node/pi/research-budget.ts.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { type CheckSpec, type IterationState, type Verdict } from '../../../../lib/node/pi/iteration-loop-schema.ts';
import {
  type BudgetSnapshot,
  budgetSnapshot,
  computeStopReason,
  createRunBudget,
  isFixpoint,
  normalizeScore,
  type PhaseBudget,
  selectBestSoFar,
  trackPhase,
} from '../../../../lib/node/pi/research-budget.ts';
import { readJournal } from '../../../../lib/node/pi/research-journal.ts';

// ──────────────────────────────────────────────────────────────────────
// Fixtures.
// ──────────────────────────────────────────────────────────────────────

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi-research-budget-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const phasePlanner: PhaseBudget = { name: 'planner', maxCostUsd: 0.05, maxWallClockSec: 30 };
const phaseSynth: PhaseBudget = { name: 'synth', maxCostUsd: 0.1, maxWallClockSec: 60 };

function approvedVerdict(score = 1): Verdict {
  return { approved: true, score, issues: [], summary: 'ok' };
}

function failingVerdict(score = 0.4): Verdict {
  return {
    approved: false,
    score,
    issues: [{ severity: 'major', description: 'not yet' }],
    summary: 'fail',
  };
}

function bashSpec(overrides: Partial<CheckSpec> = {}): CheckSpec {
  return {
    task: 'default',
    kind: 'bash',
    artifact: 'out.txt',
    spec: { cmd: 'true' },
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function state(overrides: Partial<IterationState> = {}): IterationState {
  return {
    task: 'default',
    iteration: 0,
    editsSinceLastCheck: 0,
    lastCheckTurn: null,
    lastVerdict: null,
    bestSoFar: null,
    costUsd: 0,
    history: [],
    stopReason: null,
    startedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// createRunBudget.
// ──────────────────────────────────────────────────────────────────────

describe('createRunBudget', () => {
  test('initializes running totals to zero', () => {
    const b = createRunBudget([phasePlanner, phaseSynth]);

    expect(b.totalCostUsd).toBe(0);
    expect(b.totalWallClockSec).toBe(0);
    expect(b.perPhaseCostUsd).toEqual({});
    expect(b.perPhaseWallClockSec).toEqual({});
    expect(b.overrunLogged.size).toBe(0);
  });

  test('copies the phases array so later mutation does not affect the budget', () => {
    const phases = [{ ...phasePlanner }];
    const b = createRunBudget(phases);
    phases[0].maxCostUsd = 999;

    expect(b.phases[0].maxCostUsd).toBe(phasePlanner.maxCostUsd);
  });

  test('stores journalPath when provided', () => {
    const journalPath = join(cwd, 'journal.md');
    const b = createRunBudget([phasePlanner], { journalPath });

    expect(b.journalPath).toBe(journalPath);
  });

  test('rejects duplicate phase names', () => {
    expect(() => createRunBudget([phasePlanner, { ...phasePlanner }])).toThrow(/duplicate phase name/);
  });

  test('rejects empty phase names', () => {
    expect(() => createRunBudget([{ name: '', maxCostUsd: 1, maxWallClockSec: 1 }])).toThrow(/phase\.name/);
  });

  test('rejects non-finite / negative caps', () => {
    expect(() => createRunBudget([{ name: 'p', maxCostUsd: Number.NaN, maxWallClockSec: 1 }])).toThrow();
    expect(() => createRunBudget([{ name: 'p', maxCostUsd: 1, maxWallClockSec: -1 }])).toThrow();
    expect(() => createRunBudget([{ name: 'p', maxCostUsd: Infinity, maxWallClockSec: 1 }])).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// trackPhase — happy path + accumulation.
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a clock that advances by `stepMs` milliseconds on each call.
 * Used to simulate wall-clock consumption without sleeping.
 */
function stepClock(startMs: number, stepMs: number): () => Date {
  let cursor = startMs;
  return () => {
    const d = new Date(cursor);
    cursor += stepMs;
    return d;
  };
}

describe('trackPhase', () => {
  test('returns the callback result', async () => {
    const b = createRunBudget([phasePlanner]);
    const out = await trackPhase(b, 'planner', () => 42);

    expect(out).toBe(42);
  });

  test('accumulates cost reported by the tracker', async () => {
    const b = createRunBudget([phasePlanner]);
    await trackPhase(b, 'planner', (t) => {
      t.addCost(0.01);
      t.addCost(0.02);
      return null;
    });

    expect(b.perPhaseCostUsd.planner).toBeCloseTo(0.03, 10);
    expect(b.totalCostUsd).toBeCloseTo(0.03, 10);
  });

  test('tracker ignores NaN / negative / Infinity', async () => {
    const b = createRunBudget([phasePlanner]);
    await trackPhase(b, 'planner', (t) => {
      t.addCost(Number.NaN);
      t.addCost(-1);
      t.addCost(Infinity);
      t.addCost(0.005);
      return null;
    });

    expect(b.perPhaseCostUsd.planner).toBeCloseTo(0.005, 10);
  });

  test('accumulates wall-clock seconds via injected clock', async () => {
    const b = createRunBudget([phasePlanner]);
    // startMs=1000, stepMs=2500 → one call before fn, one after → 2.5s.
    const now = stepClock(1000, 2500);

    await trackPhase(b, 'planner', () => null, { now });

    expect(b.perPhaseWallClockSec.planner).toBeCloseTo(2.5, 6);
    expect(b.totalWallClockSec).toBeCloseTo(2.5, 6);
  });

  test('accumulates across multiple calls for the same phase', async () => {
    const b = createRunBudget([phasePlanner]);
    const now = stepClock(0, 1000);

    await trackPhase(b, 'planner', (t) => t.addCost(0.01), { now });
    await trackPhase(b, 'planner', (t) => t.addCost(0.02), { now });

    expect(b.perPhaseCostUsd.planner).toBeCloseTo(0.03, 10);
    // Two calls × 1s each = 2s total.
    expect(b.perPhaseWallClockSec.planner).toBeCloseTo(2.0, 6);
  });

  test('records totals even when the callback throws', async () => {
    const b = createRunBudget([phasePlanner]);
    const now = stepClock(0, 1000);

    await expect(
      trackPhase(
        b,
        'planner',
        (t) => {
          t.addCost(0.02);
          throw new Error('boom');
        },
        { now },
      ),
    ).rejects.toThrow('boom');

    expect(b.perPhaseCostUsd.planner).toBeCloseTo(0.02, 10);
    expect(b.perPhaseWallClockSec.planner).toBeCloseTo(1, 6);
  });

  test('rejects an unknown phase name', async () => {
    const b = createRunBudget([phasePlanner]);

    await expect(trackPhase(b, 'missing', () => null)).rejects.toThrow(/unknown phase "missing"/);
  });

  test('tracker.costUsd reflects the accumulated value within the callback', async () => {
    const b = createRunBudget([phasePlanner]);
    let snapshot = -1;
    await trackPhase(b, 'planner', (t) => {
      t.addCost(0.01);
      t.addCost(0.005);
      snapshot = t.costUsd;
      return null;
    });

    expect(snapshot).toBeCloseTo(0.015, 10);
  });
});

// ──────────────────────────────────────────────────────────────────────
// trackPhase — overrun journal entries.
// ──────────────────────────────────────────────────────────────────────

describe('trackPhase — overrun logging', () => {
  test('writes a warn entry when the cost cap is exceeded', async () => {
    const journalPath = join(cwd, 'journal.md');
    const b = createRunBudget([phasePlanner], { journalPath });

    await trackPhase(b, 'planner', (t) => {
      t.addCost(phasePlanner.maxCostUsd + 0.01);
    });

    const entries = readJournal(journalPath);

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('warn');
    expect(entries[0].heading).toContain('planner');
    expect(entries[0].heading).toContain('cost cap');
    expect(entries[0].body).toMatch(/USD/);
  });

  test('writes a warn entry when the wall-clock cap is exceeded', async () => {
    const journalPath = join(cwd, 'journal.md');
    const b = createRunBudget([{ name: 'tiny', maxCostUsd: 10, maxWallClockSec: 1 }], { journalPath });
    // 2s elapsed against a 1s cap.
    const now = stepClock(0, 2000);

    await trackPhase(b, 'tiny', () => null, { now });

    const entries = readJournal(journalPath);

    expect(entries).toHaveLength(1);
    expect(entries[0].heading).toContain('wall-clock cap');
  });

  test('logs cost AND wall overruns separately (both dimensions)', async () => {
    const journalPath = join(cwd, 'journal.md');
    const b = createRunBudget([{ name: 'x', maxCostUsd: 0.001, maxWallClockSec: 0.5 }], { journalPath });
    const now = stepClock(0, 1000);

    await trackPhase(
      b,
      'x',
      (t) => {
        t.addCost(0.01);
      },
      { now },
    );

    const entries = readJournal(journalPath);

    expect(entries).toHaveLength(2);

    const headings = entries.map((e) => e.heading).join('\n');

    expect(headings).toContain('cost cap');
    expect(headings).toContain('wall-clock cap');
  });

  test('does not re-log an already-logged overrun on subsequent calls', async () => {
    const journalPath = join(cwd, 'journal.md');
    const b = createRunBudget([phasePlanner], { journalPath });

    await trackPhase(b, 'planner', (t) => {
      t.addCost(phasePlanner.maxCostUsd + 0.01);
    });
    await trackPhase(b, 'planner', (t) => {
      t.addCost(0.02);
    });
    await trackPhase(b, 'planner', (t) => {
      t.addCost(0.02);
    });

    const entries = readJournal(journalPath);

    // Only the first overrun logs; totals keep accumulating silently.
    expect(entries).toHaveLength(1);
    expect(b.perPhaseCostUsd.planner).toBeGreaterThan(phasePlanner.maxCostUsd);
  });

  test('tracks overruns in the in-memory set even without a journal path', async () => {
    const b = createRunBudget([phasePlanner]);

    await trackPhase(b, 'planner', (t) => {
      t.addCost(phasePlanner.maxCostUsd + 1);
    });

    expect(b.overrunLogged.has('planner:cost')).toBe(true);
    // Wall-clock was not exceeded (instant callback).
    expect(b.overrunLogged.has('planner:wall')).toBe(false);
  });

  test('does not log when both dimensions are under cap', async () => {
    const journalPath = join(cwd, 'journal.md');
    const b = createRunBudget([phasePlanner], { journalPath });

    await trackPhase(b, 'planner', (t) => t.addCost(0.001));

    expect(readJournal(journalPath)).toEqual([]);
  });

  test('journal entry body carries numeric detail of the overrun', async () => {
    const journalPath = join(cwd, 'journal.md');
    const b = createRunBudget([{ name: 'p', maxCostUsd: 0.01, maxWallClockSec: 1000 }], { journalPath });

    await trackPhase(b, 'p', (t) => t.addCost(0.1));

    const e = readJournal(journalPath)[0];

    expect(e.body).toMatch(/0\.100000/);
    expect(e.body).toMatch(/0\.010000/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// computeStopReason — covers every stop reason the module produces.
// ──────────────────────────────────────────────────────────────────────

describe('computeStopReason — every stop reason', () => {
  test('returns null when no cap is hit and no verdict is approved', () => {
    expect(
      computeStopReason({
        spec: bashSpec(),
        state: state({
          iteration: 1,
          lastVerdict: failingVerdict(),
          costUsd: 0.001,
          startedAt: '2025-01-01T00:00:00.000Z',
        }),
        currentArtifactHash: 'a',
        previousArtifactHash: null,
        now: new Date('2025-01-01T00:00:01.000Z'),
      }),
    ).toBeNull();
  });

  test('returns "passed" when the latest verdict is approved', () => {
    expect(
      computeStopReason({
        spec: bashSpec(),
        state: state({
          iteration: 1,
          lastVerdict: approvedVerdict(),
          costUsd: 0,
          startedAt: '2025-01-01T00:00:00.000Z',
        }),
        currentArtifactHash: 'a',
        previousArtifactHash: 'b',
        now: new Date('2025-01-01T00:00:01.000Z'),
      }),
    ).toBe('passed');
  });

  test('"passed" outranks "budget-iter" / "budget-cost" / "wall-clock"', () => {
    // Hit all budget caps simultaneously — `passed` still wins.
    expect(
      computeStopReason({
        spec: bashSpec({ budget: { maxIter: 1, maxCostUsd: 0.01, wallClockSeconds: 1 } }),
        state: state({
          iteration: 5,
          lastVerdict: approvedVerdict(),
          costUsd: 1,
          startedAt: '2025-01-01T00:00:00.000Z',
        }),
        currentArtifactHash: 'a',
        previousArtifactHash: 'b',
        now: new Date('2025-01-01T01:00:00.000Z'),
      }),
    ).toBe('passed');
  });

  test('returns "fixpoint" when the current and previous snapshot hashes match', () => {
    expect(
      computeStopReason({
        spec: bashSpec({ budget: { maxIter: 99, maxCostUsd: 99, wallClockSeconds: 99999 } }),
        state: state({
          iteration: 2,
          lastVerdict: failingVerdict(),
          costUsd: 0,
          startedAt: '2025-01-01T00:00:00.000Z',
        }),
        currentArtifactHash: 'same',
        previousArtifactHash: 'same',
        now: new Date('2025-01-01T00:00:01.000Z'),
      }),
    ).toBe('fixpoint');
  });

  test('returns "budget-cost" when cumulative cost >= cap', () => {
    expect(
      computeStopReason({
        spec: bashSpec({ budget: { maxCostUsd: 0.05, maxIter: 99, wallClockSeconds: 99999 } }),
        state: state({
          iteration: 1,
          lastVerdict: failingVerdict(),
          costUsd: 0.05,
          startedAt: '2025-01-01T00:00:00.000Z',
        }),
        currentArtifactHash: 'a',
        previousArtifactHash: 'b',
        now: new Date('2025-01-01T00:00:01.000Z'),
      }),
    ).toBe('budget-cost');
  });

  test('returns "budget-iter" when iteration >= maxIter and cost still under', () => {
    expect(
      computeStopReason({
        spec: bashSpec({ budget: { maxIter: 3, maxCostUsd: 99, wallClockSeconds: 99999 } }),
        state: state({
          iteration: 3,
          lastVerdict: failingVerdict(),
          costUsd: 0,
          startedAt: '2025-01-01T00:00:00.000Z',
        }),
        currentArtifactHash: 'a',
        previousArtifactHash: 'b',
        now: new Date('2025-01-01T00:00:01.000Z'),
      }),
    ).toBe('budget-iter');
  });

  test('returns "wall-clock" when elapsed seconds >= wallClockSeconds', () => {
    expect(
      computeStopReason({
        spec: bashSpec({ budget: { wallClockSeconds: 10, maxIter: 99, maxCostUsd: 99 } }),
        state: state({
          iteration: 1,
          lastVerdict: failingVerdict(),
          costUsd: 0,
          startedAt: '2025-01-01T00:00:00.000Z',
        }),
        currentArtifactHash: 'a',
        previousArtifactHash: 'b',
        now: new Date('2025-01-01T00:00:10.000Z'),
      }),
    ).toBe('wall-clock');
  });

  test('does not fire "fixpoint" when current hash is null', () => {
    expect(
      computeStopReason({
        spec: bashSpec(),
        state: state({
          iteration: 1,
          lastVerdict: failingVerdict(),
          costUsd: 0,
          startedAt: '2025-01-01T00:00:00.000Z',
        }),
        currentArtifactHash: null,
        previousArtifactHash: null,
        now: new Date('2025-01-01T00:00:01.000Z'),
      }),
    ).toBeNull();
  });

  test('does not fire "fixpoint" when previous hash is null', () => {
    expect(
      computeStopReason({
        spec: bashSpec(),
        state: state({
          iteration: 1,
          lastVerdict: failingVerdict(),
          costUsd: 0,
          startedAt: '2025-01-01T00:00:00.000Z',
        }),
        currentArtifactHash: 'a',
        previousArtifactHash: null,
        now: new Date('2025-01-01T00:00:01.000Z'),
      }),
    ).toBeNull();
  });

  test('"budget-cost" outranks "budget-iter" and "wall-clock" (precedence order)', () => {
    // All three caps hit simultaneously. The iteration-loop's
    // precedence contract (cost → iter → wall) carries through the
    // research-core re-export.
    expect(
      computeStopReason({
        spec: bashSpec({ budget: { maxIter: 1, maxCostUsd: 0.01, wallClockSeconds: 1 } }),
        state: state({
          iteration: 99,
          lastVerdict: failingVerdict(),
          costUsd: 999,
          startedAt: '2025-01-01T00:00:00.000Z',
        }),
        currentArtifactHash: 'a',
        previousArtifactHash: 'b',
        now: new Date('2025-01-01T01:00:00.000Z'),
      }),
    ).toBe('budget-cost');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Re-exported helpers remain functional under the research path.
// ──────────────────────────────────────────────────────────────────────

describe('re-exported helpers', () => {
  test('selectBestSoFar prefers approved candidates over unapproved incumbents', () => {
    const current = { iteration: 1, score: 0.9, approved: false, snapshotPath: '/a', artifactHash: 'a' };
    const candidate = { iteration: 2, score: 0.5, approved: true, snapshotPath: '/b', artifactHash: 'b' };

    expect(selectBestSoFar(current, candidate)).toBe(candidate);
  });

  test('selectBestSoFar keeps the higher-scored when approval is tied', () => {
    const current = { iteration: 1, score: 0.8, approved: false, snapshotPath: '/a', artifactHash: 'a' };
    const candidate = { iteration: 2, score: 0.9, approved: false, snapshotPath: '/b', artifactHash: 'b' };

    expect(selectBestSoFar(current, candidate)).toBe(candidate);
  });

  test('isFixpoint handles null prev / non-match / match', () => {
    expect(isFixpoint(null, 'a')).toBe(false);
    expect(isFixpoint('a', 'b')).toBe(false);
    expect(isFixpoint('a', 'a')).toBe(true);
  });

  test('normalizeScore clamps to [0, 1]', () => {
    const clamp = (score: number, approved: boolean): number => normalizeScore({ approved, score, issues: [] });

    expect(clamp(-1, false)).toBe(0);
    expect(clamp(2, true)).toBe(1);
    expect(clamp(0.5, true)).toBe(0.5);
    expect(clamp(Number.NaN, true)).toBe(1);
    expect(clamp(Number.NaN, false)).toBe(0);
  });

  test('budgetSnapshot projects the current budget totals', () => {
    const spec = bashSpec({ budget: { maxIter: 5, maxCostUsd: 0.5, wallClockSeconds: 60 } });
    const s = state({ iteration: 2, costUsd: 0.1, startedAt: '2025-01-01T00:00:00.000Z' });
    const snap: BudgetSnapshot = budgetSnapshot(spec, s, new Date('2025-01-01T00:00:10.000Z'));

    expect(snap.iterUsed).toBe(2);
    expect(snap.iterMax).toBe(5);
    expect(snap.costUsed).toBeCloseTo(0.1, 10);
    expect(snap.costMax).toBeCloseTo(0.5, 10);
    expect(snap.wallElapsedSec).toBe(10);
    expect(snap.wallMaxSec).toBe(60);
  });
});
