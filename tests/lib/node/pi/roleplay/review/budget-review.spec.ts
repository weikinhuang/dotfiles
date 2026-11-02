/**
 * Regression: depth-lore budgeting charges exactly what is delivered
 * (`[Lore — name: body]` insertions, merged with blank lines, no header and
 * no dropped-entries trailer) via `selectDepthLoreWithinBudget`, while the
 * keyword-lore block keeps its header + trailer accounting.
 */
import { expect, test } from 'vitest';

import { selectWithinBudget, type LoreChunk } from '../../../../../../lib/node/pi/roleplay/budget.ts';
import { formatLoreBlock } from '../../../../../../lib/node/pi/roleplay/prompt.ts';
import {
  buildInsertions,
  planDepthTailMerge,
  selectDepthLoreWithinBudget,
} from '../../../../../../lib/node/pi/roleplay/inject.ts';
import { emptyLoreMeta, type RoleplayEntry } from '../../../../../../lib/node/pi/roleplay/store.ts';

function depthChunk(id: string, order: number, bodyLen: number): LoreChunk {
  const entry: RoleplayEntry = {
    id,
    kind: 'lore',
    name: id,
    description: '',
    lore: { ...emptyLoreMeta(), order, depth: 2, constant: true },
  };
  return { entry, body: 'x'.repeat(bodyLen) };
}

/** Mirror of buildDepthLore + buildInsertions: what the model actually receives. */
function renderDepth(chunks: readonly LoreChunk[], budget: number): { kept: string[]; texts: string[] } {
  const { kept } = selectDepthLoreWithinBudget(chunks, budget);
  const lore = kept.map((c) => ({ name: c.entry.name, body: c.body, depth: c.entry.lore?.depth ?? 0 }));
  return { kept: kept.map((c) => c.entry.id), texts: buildInsertions({ lore }).map((i) => i.text) };
}

test('budget-review: depth lore that fits is not evicted to make room for a trailer that is never rendered', () => {
  // a + b render to ~2 x 242 chars (fits 500); c (400) cannot fit and is dropped.
  const chunks = [depthChunk('a', 3, 230), depthChunk('b', 2, 230), depthChunk('c', 1, 400)];
  const { kept, texts } = renderDepth(chunks, 500);
  const rendered = texts.reduce((n, t) => n + t.length, 0);
  expect(rendered).toBeLessThan(500); // sanity: a + b genuinely fit as depth insertions
  expect(kept).toEqual(['a', 'b']);
});

test('budget-review: kept depth lore fills loreCharBudget exactly as rendered (merged tail is the bound)', () => {
  const mk = (id: string, order: number, len: number): LoreChunk => {
    const c = depthChunk(id, order, len);
    if (c.entry.lore) c.entry.lore.constant = false;
    return c;
  };
  // `[Lore — a: ` + 240 + `]` = 252; 252 + 2 + (12 + 234) = 500.
  const fits = renderDepth([mk('a', 2, 240), mk('b', 1, 234)], 500);
  expect(fits.kept).toEqual(['a', 'b']);
  const merged = planDepthTailMerge(fits.texts.map((text) => ({ depth: 0, text }))).tailBlock ?? '';
  expect(merged.length).toBe(500);
  expect(fits.texts.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(500);
  // One more char of body no longer fits.
  expect(renderDepth([mk('a', 2, 240), mk('b', 1, 235)], 500).kept).toEqual(['a']);
});

test('budget-review: constant depth lore is charged without the keyword block (always-on) label', () => {
  const a = depthChunk('a', 2, 487); // `[Lore — a: ` + 487 + `]` = 499
  const b = depthChunk('b', 1, 1); // `[Lore — b: x]` = 13
  const { kept, texts } = renderDepth([a, b], 499 + 2 + 13);
  expect(texts.map((t) => t.length)).toEqual([499, 13]);
  expect(kept).toEqual(['a', 'b']);
  expect(renderDepth([a, b], 499 + 2 + 12).kept).toEqual(['a']);
});

test('budget-review: keyword lore still reserves its trailer and fits the rendered block', () => {
  const kw = (id: string, order: number, len: number): LoreChunk => {
    const c = depthChunk(id, order, len);
    if (c.entry.lore) {
      c.entry.lore.constant = false;
      delete c.entry.lore.depth;
    }
    return c;
  };
  const chunks = [kw('a', 3, 200), kw('b', 2, 200), kw('c', 1, 400)];
  // Header + a + b fit 500 on their own, but not with the trailer for c, so b is evicted to make room.
  const tight = selectWithinBudget(chunks, 500);
  expect(tight.kept.map((c) => c.entry.id)).toEqual(['a']);
  expect(tight.dropped.map((e) => e.id)).toEqual(['b', 'c']);
  const roomy = selectWithinBudget(chunks, 560);
  expect(roomy.kept.map((c) => c.entry.id)).toEqual(['a', 'b']);
  const block = formatLoreBlock(roomy) ?? '';
  expect(block).toContain('(lore budget reached; 1 more entry(ies) not shown: c)');
  expect(block.length).toBeLessThanOrEqual(560);
});
