/**
 * Tests for lib/node/pi/context-budget.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { expect, test } from 'vitest';
import {
  type ContextUsageLike,
  formatBudgetLine,
  formatTokens,
  shouldAutoCompact,
} from '../../../../lib/node/pi/context-budget.ts';

// ──────────────────────────────────────────────────────────────────────
// formatTokens
// ──────────────────────────────────────────────────────────────────────

test('formatTokens: zero / negative / NaN → "0"', () => {
  expect(formatTokens(0)).toBe('0');
  expect(formatTokens(-5)).toBe('0');
  expect(formatTokens(Number.NaN)).toBe('0');
});

test('formatTokens: below 1000 rounds to an integer', () => {
  expect(formatTokens(42)).toBe('42');
  expect(formatTokens(999)).toBe('999');
});

test('formatTokens: 1k–999k rounds to nearest k', () => {
  expect(formatTokens(1000)).toBe('1k');
  expect(formatTokens(1500)).toBe('2k');
  expect(formatTokens(45_000)).toBe('45k');
  expect(formatTokens(999_500)).toBe('1000k'); // rounds up (still under 1M)
});

test('formatTokens: ≥ 1M uses M suffix with 2 decimals under 10M, 1 decimal at/above', () => {
  expect(formatTokens(1_000_000)).toBe('1.00M');
  expect(formatTokens(1_234_000)).toBe('1.23M');
  expect(formatTokens(10_000_000)).toBe('10.0M');
  expect(formatTokens(12_500_000)).toBe('12.5M');
});

// ──────────────────────────────────────────────────────────────────────
// formatBudgetLine
// ──────────────────────────────────────────────────────────────────────

const usage = (tokens: number | null, contextWindow: number, percent: number | null): ContextUsageLike => ({
  tokens,
  contextWindow,
  percent,
});

test('formatBudgetLine: null / undefined usage → null', () => {
  expect(formatBudgetLine(null)).toBe(null);
  expect(formatBudgetLine(undefined)).toBe(null);
});

test('formatBudgetLine: unknown percent / tokens → null', () => {
  expect(formatBudgetLine(usage(null, 200_000, null))).toBe(null);
  expect(formatBudgetLine(usage(100, 200_000, null))).toBe(null);
});

test('formatBudgetLine: below min-percent → null', () => {
  expect(formatBudgetLine(usage(10_000, 200_000, 5), { minPercent: 50 })).toBe(null);
  expect(formatBudgetLine(usage(99_000, 200_000, 49.5), { minPercent: 50 })).toBe(null);
});

test('formatBudgetLine: neutral tone in 50–80% band', () => {
  const line = formatBudgetLine(usage(140_000, 200_000, 70));

  expect(line).toBeTruthy();
  expect(line!).toMatch(/70% used/);
  expect(line!).toMatch(/60k tokens left of 200k/);
  expect(line!).toMatch(/Prefer targeted `rg`/i);
  // No "be efficient" wording yet
  expect(line!).not.toMatch(/be efficient/i);
  expect(line!).not.toMatch(/running out/i);
});

test('formatBudgetLine: "be efficient" tone in 80–90% band', () => {
  const line = formatBudgetLine(usage(170_000, 200_000, 85));

  expect(line).toBeTruthy();
  expect(line!).toMatch(/85% used/);
  expect(line!).toMatch(/Be efficient/i);
  expect(line!).not.toMatch(/running out/i);
});

test('formatBudgetLine: critical tone at or above 90%', () => {
  const line = formatBudgetLine(usage(184_000, 200_000, 92));

  expect(line).toBeTruthy();
  expect(line!).toMatch(/92% used/);
  expect(line!).toMatch(/running out/i);
  expect(line!).toMatch(/\/compact/);
});

test('formatBudgetLine: percent is rounded (integer) in the rendered string', () => {
  const line = formatBudgetLine(usage(125_500, 200_000, 62.75));

  expect(line!).toMatch(/63% used/);
});

test('formatBudgetLine: respects custom thresholds', () => {
  // Raise min to 60 → 55% is silent.
  expect(formatBudgetLine(usage(110_000, 200_000, 55), { minPercent: 60 })).toBe(null);

  // Lower critical to 70 → 75% triggers critical wording.
  const line = formatBudgetLine(usage(150_000, 200_000, 75), { criticalPercent: 70 });

  expect(line!).toMatch(/running out/i);
});

test('formatBudgetLine: tokens left is never negative', () => {
  // Malformed usage where tokens exceeds the window (clamping guard).
  const line = formatBudgetLine(usage(220_000, 200_000, 100));

  expect(line!).toMatch(/0 tokens left/);
});

// ──────────────────────────────────────────────────────────────────────
// shouldAutoCompact
// ──────────────────────────────────────────────────────────────────────

test('shouldAutoCompact: below threshold → false', () => {
  expect(shouldAutoCompact(70, 60, 80)).toBe(false);
});

test('shouldAutoCompact: edge-triggers on first crossing', () => {
  expect(shouldAutoCompact(82, 70, 80)).toBe(true);
});

test('shouldAutoCompact: does NOT re-fire when previous was already above', () => {
  expect(shouldAutoCompact(85, 82, 80)).toBe(false);
});

test('shouldAutoCompact: current exactly on threshold counts as crossing', () => {
  expect(shouldAutoCompact(80, 79, 80)).toBe(true);
});

test('shouldAutoCompact: unknown current → false', () => {
  expect(shouldAutoCompact(null, 70, 80)).toBe(false);
  expect(shouldAutoCompact(undefined, 70, 80)).toBe(false);
});

test('shouldAutoCompact: unknown previous → false (no edge info)', () => {
  expect(shouldAutoCompact(85, null, 80)).toBe(false);
  expect(shouldAutoCompact(85, undefined, 80)).toBe(false);
});

test('shouldAutoCompact: invalid threshold → false', () => {
  expect(shouldAutoCompact(85, 70, 0)).toBe(false);
  expect(shouldAutoCompact(85, 70, 100)).toBe(false);
  expect(shouldAutoCompact(85, 70, -5)).toBe(false);
  expect(shouldAutoCompact(85, 70, Number.NaN)).toBe(false);
});
