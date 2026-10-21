/**
 * Tests for lib/node/pi/roleplay/budget.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  chunkCost,
  LORE_BLOCK_HEADER,
  type LoreChunk,
  rankLore,
  selectWithinBudget,
} from '../../../../../lib/node/pi/roleplay/budget.ts';
import { formatLoreBlock } from '../../../../../lib/node/pi/roleplay/prompt.ts';
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

// ── chunkCost ────────────────────────────────────────────────────────────

test('chunkCost counts the rendered heading + newline + separator framing', () => {
  // Renders as "### Name\nbody" then a "\n\n" separator to the prior block.
  const c = chunk('Name', 0, 'body');
  expect(chunkCost(c)).toBe('### '.length + 'Name'.length + 1 + 'body'.length + 2);
});

test('chunkCost adds the always-on suffix for constant lore', () => {
  const c: LoreChunk = {
    entry: {
      id: 'x',
      kind: 'lore',
      name: 'X',
      description: '',
      lore: { ...emptyLoreMeta(), constant: true },
    } satisfies RoleplayEntry,
    body: 'b',
  };
  expect(chunkCost(c)).toBe('### '.length + 'X'.length + ' (always-on)'.length + 1 + 'b'.length + 2);
});

test('chunkCost measures the trimmed body (framing not undercounted)', () => {
  // The old cost was name.length + body.length + 8; a body needing trimming
  // plus the real framing must be reflected so kept lore cannot overflow.
  const c = chunk('n', 0, '  spaced body  ');
  expect(chunkCost(c)).toBe('### '.length + 'n'.length + 1 + 'spaced body'.length + 2);
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

test('budget accounting matches the rendered block exactly (header once, no trailer)', () => {
  const chunks = [chunk('a', 3, 'alpha body'), chunk('b', 2, 'beta body')];
  const exact = (formatLoreBlock({ kept: chunks, dropped: [] }) ?? '').length;
  expect(exact).toBe(LORE_BLOCK_HEADER.length + chunks.reduce((n, c) => n + chunkCost(c), 0));
  const fits = selectWithinBudget(chunks, exact);
  expect(fits.kept).toHaveLength(2);
  expect(fits.dropped).toHaveLength(0);
});

test('rendered block (including the dropped trailer) never exceeds the budget once >1 chunk is kept', () => {
  const chunks = Array.from({ length: 12 }, (_, i) =>
    chunk(`entry${String(i).padStart(2, '0')}`, 100 - i, 'z'.repeat(40)),
  );
  for (let budget = 100; budget <= 1200; budget += 7) {
    const result = selectWithinBudget(chunks, budget);
    expect(result.kept.length + result.dropped.length).toBe(chunks.length);
    expect(result.kept[0].entry.id).toBe('entry00');
    // Dropped stays in rank order.
    expect(result.dropped.map((e) => e.id)).toStrictEqual(result.dropped.map((e) => e.id).toSorted());
    expect(result.kept.length <= 1 || (formatLoreBlock(result) ?? '').length <= budget).toBe(true);
  }
});

test('trailer overflow evicts the lowest-ranked kept chunk but never the first', () => {
  const chunks = [chunk('a', 3, 'x'.repeat(10)), chunk('b', 2, 'x'.repeat(10)), chunk('c', 1, 'x'.repeat(500))];
  const headerPlusTwo = LORE_BLOCK_HEADER.length + chunkCost(chunks[0]) + chunkCost(chunks[1]);
  // Room for a + b but not for the trailer naming c.
  const result = selectWithinBudget(chunks, headerPlusTwo + 5);
  expect(result.kept.map((c) => c.entry.id)).toStrictEqual(['a']);
  expect(result.dropped.map((e) => e.id)).toStrictEqual(['b', 'c']);
});

test('selectWithinBudget headerChars: 0 drops the header charge (depth lore renders no header)', () => {
  const a = chunk('a', 2, 'x'.repeat(20));
  const b = chunk('b', 1, 'y'.repeat(20));
  const budget = chunkCost(a) + chunkCost(b);
  expect(selectWithinBudget([a, b], budget).kept.map((c) => c.entry.id)).toStrictEqual(['a']);
  expect(selectWithinBudget([a, b], budget, { headerChars: 0 }).kept.map((c) => c.entry.id)).toStrictEqual(['a', 'b']);
});
