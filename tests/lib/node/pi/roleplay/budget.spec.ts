/**
 * Tests for lib/node/pi/roleplay/budget.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { type LoreChunk, rankLore, selectWithinBudget } from '../../../../../lib/node/pi/roleplay/budget.ts';
import { emptyLoreMeta, type RoleplayEntry } from '../../../../../lib/node/pi/roleplay/store.ts';

const chunk = (id: string, order: number, body: string): LoreChunk => ({
  entry: {
    id,
    kind: 'lore',
    name: id,
    description: `desc ${id}`,
    lore: { ...emptyLoreMeta(), order },
  } satisfies RoleplayEntry,
  body,
});

// ── rankLore ─────────────────────────────────────────────────────────────

test('rankLore sorts by order desc then name', () => {
  const ranked = rankLore([chunk('b', 10, 'x'), chunk('a', 100, 'x'), chunk('c', 10, 'x')]);
  expect(ranked.map((c) => c.entry.id)).toStrictEqual(['a', 'b', 'c']);
});

// ── selectWithinBudget ───────────────────────────────────────────────────

test('keeps everything when within budget', () => {
  const { kept, dropped } = selectWithinBudget([chunk('a', 0, 'short'), chunk('b', 0, 'short')], 10_000);
  expect(kept).toHaveLength(2);
  expect(dropped).toHaveLength(0);
});

test('evicts lowest-priority chunks past the budget', () => {
  const big = 'x'.repeat(200);
  const { kept, dropped } = selectWithinBudget([chunk('lo', 1, big), chunk('hi', 100, big)], 250);
  expect(kept.map((c) => c.entry.id)).toStrictEqual(['hi']);
  expect(dropped.map((e) => e.id)).toStrictEqual(['lo']);
});

test('always keeps the top-ranked chunk even when it alone exceeds budget', () => {
  const { kept, dropped } = selectWithinBudget([chunk('hi', 100, 'x'.repeat(9999)), chunk('lo', 1, 'y')], 10);
  expect(kept.map((c) => c.entry.id)).toStrictEqual(['hi']);
  expect(dropped.map((e) => e.id)).toStrictEqual(['lo']);
});
