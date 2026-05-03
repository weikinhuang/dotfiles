/**
 * Tests for lib/node/pi/iteration-loop-budget.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  budgetSnapshot,
  computeStopReason,
  isFixpoint,
  normalizeScore,
  selectBestSoFar,
} from '../../../../lib/node/pi/iteration-loop-budget.ts';
import { type CheckSpec, type IterationState, type Verdict } from '../../../../lib/node/pi/iteration-loop-schema.ts';

const startedAt = '2026-05-01T00:00:00Z';

const baseSpec = (overrides: Partial<CheckSpec> = {}): CheckSpec => ({
  task: 'default',
  kind: 'bash',
  artifact: 'out.svg',
  spec: { cmd: 'true' },
  createdAt: startedAt,
  ...overrides,
});

const baseState = (
  overrides: Partial<Pick<IterationState, 'iteration' | 'lastVerdict' | 'costUsd' | 'startedAt'>> = {},
): Pick<IterationState, 'iteration' | 'lastVerdict' | 'costUsd' | 'startedAt'> => ({
  iteration: 1,
  lastVerdict: null,
  costUsd: 0,
  startedAt,
  ...overrides,
});

const approvedVerdict = (): Verdict => ({ approved: true, score: 1, issues: [] });
const notApprovedVerdict = (score = 0.5): Verdict => ({
  approved: false,
  score,
  issues: [{ severity: 'major', description: 'x' }],
});

describe('isFixpoint', () => {
  test('true only when prevHash non-null and equals current', () => {
    expect(isFixpoint(null, 'abc')).toBe(false);
    expect(isFixpoint('abc', 'abc')).toBe(true);
    expect(isFixpoint('abc', 'def')).toBe(false);
  });
});

describe('computeStopReason precedence', () => {
  const now = new Date('2026-05-01T00:00:30Z'); // 30s elapsed

  test('null when nothing triggers', () => {
    expect(
      computeStopReason({
        spec: baseSpec({ budget: { maxIter: 5 } }),
        state: baseState({ iteration: 1, lastVerdict: notApprovedVerdict() }),
        currentArtifactHash: 'h1',
        previousArtifactHash: null,
        now,
      }),
    ).toBeNull();
  });

  test('passed outranks everything', () => {
    expect(
      computeStopReason({
        // Budget would be exhausted if we looked at it
        spec: baseSpec({ budget: { maxIter: 1, maxCostUsd: 0.0 } }),
        state: baseState({ iteration: 5, lastVerdict: approvedVerdict(), costUsd: 5 }),
        currentArtifactHash: 'h1',
        previousArtifactHash: 'h1', // would fixpoint
        now,
      }),
    ).toBe('passed');
  });

  test('fixpoint outranks budgets', () => {
    expect(
      computeStopReason({
        spec: baseSpec({ budget: { maxIter: 5, maxCostUsd: 1 } }),
        state: baseState({ iteration: 2, lastVerdict: notApprovedVerdict(), costUsd: 0 }),
        currentArtifactHash: 'h1',
        previousArtifactHash: 'h1',
        now,
      }),
    ).toBe('fixpoint');
  });

  test('budget-cost before budget-iter', () => {
    expect(
      computeStopReason({
        spec: baseSpec({ budget: { maxIter: 2, maxCostUsd: 0.1 } }),
        state: baseState({ iteration: 2, lastVerdict: notApprovedVerdict(), costUsd: 0.1 }),
        currentArtifactHash: 'h1',
        previousArtifactHash: 'h0',
        now,
      }),
    ).toBe('budget-cost');
  });

  test('budget-iter when iter cap reached', () => {
    expect(
      computeStopReason({
        spec: baseSpec({ budget: { maxIter: 2, maxCostUsd: 1 } }),
        state: baseState({ iteration: 2, lastVerdict: notApprovedVerdict(), costUsd: 0 }),
        currentArtifactHash: 'h1',
        previousArtifactHash: 'h0',
        now,
      }),
    ).toBe('budget-iter');
  });

  test('wall-clock when elapsed >= cap', () => {
    expect(
      computeStopReason({
        spec: baseSpec({ budget: { maxIter: 99, maxCostUsd: 99, wallClockSeconds: 10 } }),
        state: baseState({ iteration: 1, lastVerdict: notApprovedVerdict() }),
        currentArtifactHash: 'h1',
        previousArtifactHash: 'h0',
        now,
      }),
    ).toBe('wall-clock');
  });

  test('invalid startedAt skips wall-clock check (no crash)', () => {
    expect(
      computeStopReason({
        spec: baseSpec({ budget: { maxIter: 99, wallClockSeconds: 10 } }),
        state: baseState({ iteration: 1, lastVerdict: notApprovedVerdict(), startedAt: 'garbage' }),
        currentArtifactHash: 'h1',
        previousArtifactHash: 'h0',
        now,
      }),
    ).toBeNull();
  });
});

describe('selectBestSoFar', () => {
  const mk = (
    iter: number,
    score: number,
    approved = false,
  ): { iteration: number; score: number; approved: boolean; snapshotPath: string; artifactHash: string } => ({
    iteration: iter,
    score,
    approved,
    snapshotPath: `/s/${iter}`,
    artifactHash: `h${iter}`,
  });

  test('null current → candidate wins', () => {
    expect(selectBestSoFar(null, mk(1, 0.3))).toEqual(mk(1, 0.3));
  });

  test('approved candidate beats not-approved current even with lower score', () => {
    expect(selectBestSoFar(mk(1, 0.9, false), mk(2, 0.1, true))).toEqual(mk(2, 0.1, true));
  });

  test('approved current beats not-approved candidate even with higher score', () => {
    // Regression: the old signature took candidateApproved only, so a
    // non-approved higher-scored candidate could clobber an approved
    // current. BestSoFar now carries its own approval flag.
    expect(selectBestSoFar(mk(1, 0.7, true), mk(2, 0.95, false))).toEqual(mk(1, 0.7, true));
  });

  test('higher score wins when both are not-approved', () => {
    expect(selectBestSoFar(mk(1, 0.3), mk(2, 0.8))).toEqual(mk(2, 0.8));
  });

  test('lower score loses when both are not-approved', () => {
    expect(selectBestSoFar(mk(1, 0.8), mk(2, 0.3))).toEqual(mk(1, 0.8));
  });

  test('tie on score → later iteration wins (when approval matches)', () => {
    expect(selectBestSoFar(mk(1, 0.5), mk(2, 0.5))).toEqual(mk(2, 0.5));
  });

  test('approved tied on score → later iteration wins', () => {
    expect(selectBestSoFar(mk(1, 0.8, true), mk(2, 0.8, true))).toEqual(mk(2, 0.8, true));
  });
});

describe('normalizeScore', () => {
  test('clamps [0,1]', () => {
    expect(normalizeScore({ approved: false, score: -0.5, issues: [] })).toBe(0);
    expect(normalizeScore({ approved: false, score: 2, issues: [] })).toBe(1);
    expect(normalizeScore({ approved: false, score: 0.5, issues: [] })).toBe(0.5);
  });

  test('NaN falls back to approved-bool', () => {
    expect(normalizeScore({ approved: true, score: Number.NaN, issues: [] })).toBe(1);
    expect(normalizeScore({ approved: false, score: Number.NaN, issues: [] })).toBe(0);
  });
});

describe('budgetSnapshot', () => {
  test('composes used/max for all dimensions', () => {
    const spec = baseSpec({ budget: { maxIter: 5, maxCostUsd: 0.1, wallClockSeconds: 60 } });
    const state: IterationState = {
      task: 'default',
      iteration: 2,
      editsSinceLastCheck: 0,
      lastCheckTurn: 3,
      lastVerdict: null,
      bestSoFar: null,
      costUsd: 0.042,
      history: [],
      stopReason: null,
      startedAt,
    };
    const snap = budgetSnapshot(spec, state, new Date('2026-05-01T00:00:10Z'));

    expect(snap.iterUsed).toBe(2);
    expect(snap.iterMax).toBe(5);
    expect(snap.costUsed).toBe(0.042);
    expect(snap.costMax).toBe(0.1);
    expect(snap.wallElapsedSec).toBe(10);
    expect(snap.wallMaxSec).toBe(60);
  });
});
