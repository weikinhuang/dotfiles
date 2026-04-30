/**
 * Tests for lib/node/pi/context-budget.ts.
 *
 * Run:  node --test config/pi/tests/extensions/context-budget.test.ts
 *   or: node --test config/pi/tests/
 *
 * Pure module — no pi runtime needed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(-5), '0');
  assert.equal(formatTokens(Number.NaN), '0');
});

test('formatTokens: below 1000 rounds to an integer', () => {
  assert.equal(formatTokens(42), '42');
  assert.equal(formatTokens(999), '999');
});

test('formatTokens: 1k–999k rounds to nearest k', () => {
  assert.equal(formatTokens(1000), '1k');
  assert.equal(formatTokens(1500), '2k');
  assert.equal(formatTokens(45_000), '45k');
  assert.equal(formatTokens(999_500), '1000k'); // rounds up (still under 1M)
});

test('formatTokens: ≥ 1M uses M suffix with 2 decimals under 10M, 1 decimal at/above', () => {
  assert.equal(formatTokens(1_000_000), '1.00M');
  assert.equal(formatTokens(1_234_000), '1.23M');
  assert.equal(formatTokens(10_000_000), '10.0M');
  assert.equal(formatTokens(12_500_000), '12.5M');
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
  assert.equal(formatBudgetLine(null), null);
  assert.equal(formatBudgetLine(undefined), null);
});

test('formatBudgetLine: unknown percent / tokens → null', () => {
  assert.equal(formatBudgetLine(usage(null, 200_000, null)), null);
  assert.equal(formatBudgetLine(usage(100, 200_000, null)), null);
});

test('formatBudgetLine: below min-percent → null', () => {
  assert.equal(formatBudgetLine(usage(10_000, 200_000, 5), { minPercent: 50 }), null);
  assert.equal(formatBudgetLine(usage(99_000, 200_000, 49.5), { minPercent: 50 }), null);
});

test('formatBudgetLine: neutral tone in 50–80% band', () => {
  const line = formatBudgetLine(usage(140_000, 200_000, 70));
  assert.ok(line);
  assert.match(line!, /70% used/);
  assert.match(line!, /60k tokens left of 200k/);
  assert.match(line!, /Prefer targeted `rg`/i);
  // No "be efficient" wording yet
  assert.ok(!/be efficient/i.test(line!));
  assert.ok(!/running out/i.test(line!));
});

test('formatBudgetLine: "be efficient" tone in 80–90% band', () => {
  const line = formatBudgetLine(usage(170_000, 200_000, 85));
  assert.ok(line);
  assert.match(line!, /85% used/);
  assert.match(line!, /Be efficient/i);
  assert.ok(!/running out/i.test(line!));
});

test('formatBudgetLine: critical tone at or above 90%', () => {
  const line = formatBudgetLine(usage(184_000, 200_000, 92));
  assert.ok(line);
  assert.match(line!, /92% used/);
  assert.match(line!, /running out/i);
  assert.match(line!, /\/compact/);
});

test('formatBudgetLine: percent is rounded (integer) in the rendered string', () => {
  const line = formatBudgetLine(usage(125_500, 200_000, 62.75));
  assert.match(line!, /63% used/);
});

test('formatBudgetLine: respects custom thresholds', () => {
  // Raise min to 60 → 55% is silent.
  assert.equal(formatBudgetLine(usage(110_000, 200_000, 55), { minPercent: 60 }), null);
  // Lower critical to 70 → 75% triggers critical wording.
  const line = formatBudgetLine(usage(150_000, 200_000, 75), { criticalPercent: 70 });
  assert.match(line!, /running out/i);
});

test('formatBudgetLine: tokens left is never negative', () => {
  // Malformed usage where tokens exceeds the window (clamping guard).
  const line = formatBudgetLine(usage(220_000, 200_000, 100));
  assert.match(line!, /0 tokens left/);
});

// ──────────────────────────────────────────────────────────────────────
// shouldAutoCompact
// ──────────────────────────────────────────────────────────────────────

test('shouldAutoCompact: below threshold → false', () => {
  assert.equal(shouldAutoCompact(70, 60, 80), false);
});

test('shouldAutoCompact: edge-triggers on first crossing', () => {
  assert.equal(shouldAutoCompact(82, 70, 80), true);
});

test('shouldAutoCompact: does NOT re-fire when previous was already above', () => {
  assert.equal(shouldAutoCompact(85, 82, 80), false);
});

test('shouldAutoCompact: current exactly on threshold counts as crossing', () => {
  assert.equal(shouldAutoCompact(80, 79, 80), true);
});

test('shouldAutoCompact: unknown current → false', () => {
  assert.equal(shouldAutoCompact(null, 70, 80), false);
  assert.equal(shouldAutoCompact(undefined, 70, 80), false);
});

test('shouldAutoCompact: unknown previous → false (no edge info)', () => {
  assert.equal(shouldAutoCompact(85, null, 80), false);
  assert.equal(shouldAutoCompact(85, undefined, 80), false);
});

test('shouldAutoCompact: invalid threshold → false', () => {
  assert.equal(shouldAutoCompact(85, 70, 0), false);
  assert.equal(shouldAutoCompact(85, 70, 100), false);
  assert.equal(shouldAutoCompact(85, 70, -5), false);
  assert.equal(shouldAutoCompact(85, 70, Number.NaN), false);
});
