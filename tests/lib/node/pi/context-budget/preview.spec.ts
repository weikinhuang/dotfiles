/**
 * Golden-output tests for lib/node/pi/context-budget/preview.ts.
 *
 * Pure module - no pi runtime needed. These assert the EXACT multi-line
 * block `/context-budget [preview]` renders, so any wording / layout
 * drift is caught.
 */

import { expect, test } from 'vitest';

import { type BudgetOptions, type ContextUsageLike } from '../../../../../lib/node/pi/context-budget.ts';
import { buildBudgetPreview } from '../../../../../lib/node/pi/context-budget/preview.ts';

const options: BudgetOptions = { minPercent: 50, warnPercent: 80, criticalPercent: 90 };

const usage = (tokens: number | null, contextWindow: number, percent: number | null): ContextUsageLike => ({
  tokens,
  contextWindow,
  percent,
});

test('buildBudgetPreview: unknown usage, auto-compact disabled', () => {
  expect(buildBudgetPreview(null, options, null, false)).toBe(
    [
      'Context usage: (unknown - typically right after compaction, before the next LLM response)',
      'Thresholds: min=50%, warn=80%, critical=90%',
      'Auto-compact: disabled (set PI_CONTEXT_BUDGET_AUTO_COMPACT_PERCENT=N to enable)',
      '',
      'No advisory would be injected next turn (usage is unknown).',
    ].join('\n'),
  );
});

test('buildBudgetPreview: undefined usage behaves like unknown', () => {
  expect(buildBudgetPreview(undefined, options, null, false)).toBe(buildBudgetPreview(null, options, null, false));
});

test('buildBudgetPreview: below min-percent, auto-compact disabled', () => {
  expect(buildBudgetPreview(usage(60_000, 200_000, 30), options, null, false)).toBe(
    [
      'Context usage: 30% - 60k used, 140k left of 200k window',
      'Thresholds: min=50%, warn=80%, critical=90%',
      'Auto-compact: disabled (set PI_CONTEXT_BUDGET_AUTO_COMPACT_PERCENT=N to enable)',
      '',
      'No advisory would be injected next turn (usage 30% is below min-percent 50%).',
    ].join('\n'),
  );
});

test('buildBudgetPreview: neutral band with auto-compact armed', () => {
  expect(buildBudgetPreview(usage(140_000, 200_000, 70), options, 90, false)).toBe(
    [
      'Context usage: 70% - 140k used, 60k left of 200k window',
      'Thresholds: min=50%, warn=80%, critical=90%',
      'Auto-compact: edge-triggers at 90% (previous turn below, current at or above)',
      '',
      "Injected into the next turn's system prompt:",
      '',
      'Context: 70% used (60k tokens left of 200k). Prefer targeted `rg` with patterns over broad reads; use `read --offset / --limit` on large files.',
    ].join('\n'),
  );
});

test('buildBudgetPreview: auto-compact already fired this session', () => {
  expect(buildBudgetPreview(usage(184_000, 200_000, 92), options, 90, true)).toBe(
    [
      'Context usage: 92% - 184k used, 16k left of 200k window',
      'Thresholds: min=50%, warn=80%, critical=90%',
      'Auto-compact: edge-triggers at 90% (previous turn below, current at or above) - already fired this session, waiting for usage to dip back under threshold',
      '',
      "Injected into the next turn's system prompt:",
      '',
      "Context: 92% used (16k tokens left of 200k). You are running out of context - finish what's essential now. Prefer targeted `rg` with patterns, `read` with `offset` / `limit`, and avoid broad reads or long bash output. Consider `/compact` if you need more room.",
    ].join('\n'),
  );
});
