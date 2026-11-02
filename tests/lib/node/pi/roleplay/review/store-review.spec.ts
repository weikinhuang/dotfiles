/**
 * Regression: the injected `## Roleplay` cast index (formatRoleplayBlock in
 * lib/node/pi/roleplay/store.ts) budgets its closing line and never emits a
 * heading whose entries were all skipped.
 */
import { expect, test } from 'vitest';

import {
  formatRoleplayBlock,
  type RoleplayEntry,
  type RoleplayKind,
} from '../../../../../../lib/node/pi/roleplay/store.ts';

const entry = (kind: RoleplayKind, id: string, description: string): RoleplayEntry => ({
  id,
  kind,
  name: id,
  description,
});

test('store-review: the whole block, trailer included, fits maxChars', () => {
  const entries = Array.from({ length: 40 }, (_, i) => entry('character', `c${i}`, 'x'.repeat(30 + (i % 7))));
  for (const maxChars of [500, 640, 777, 1000, 1500]) {
    const block = formatRoleplayBlock({ cast: 'pl', entries }, { maxChars }) ?? '';
    expect(block.length).toBeLessThanOrEqual(maxChars);
    expect(block).toMatch(/more entry\(ies\) not shown/);
  }
});

test('store-review: a kind whose entries are all skipped leaves no empty heading', () => {
  const entries = [
    entry('character', 'a', 'x'.repeat(300)),
    entry('lore', 'big', 'y'.repeat(300)), // cannot fit after `a`
    entry('summary', 's', 'short'), // still fits
  ];
  const block = formatRoleplayBlock({ cast: 'pl', entries }, { maxChars: 500 }) ?? '';
  expect(block).toContain('### Characters');
  expect(block).not.toContain('### Lore');
  expect(block).toContain('### Summaries\n- s (`s`) - short');
  expect(block).toContain('(1 more entry(ies) not shown');
  expect(block.length).toBeLessThanOrEqual(500);
});

test('store-review: the first entry is always shown and an untruncated block ends with the read hint', () => {
  const huge = formatRoleplayBlock(
    { cast: 'pl', entries: [entry('character', 'a', 'z'.repeat(2000))] },
    { maxChars: 500 },
  );
  expect(huge).toContain('- a (`a`)');
  const small = formatRoleplayBlock({ cast: 'pl', entries: [entry('lore', 'l', 'd')] }) ?? '';
  expect(small.endsWith('to load a full sheet; `save` to add one.')).toBe(true);
});
