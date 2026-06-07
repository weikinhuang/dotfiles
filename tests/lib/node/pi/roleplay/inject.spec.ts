/**
 * Tests for lib/node/pi/roleplay/inject.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  applyInsertions,
  buildInsertions,
  DEFAULT_AUTHOR_NOTE_DEPTH,
  formatAuthorNote,
  formatDepthLore,
} from '../../../../../lib/node/pi/roleplay/inject.ts';

// ── Formatters ────────────────────────────────────────────────────────────

test('formatters frame author note + lore', () => {
  expect(formatAuthorNote('  stay terse ')).toBe("[Author's note: stay terse]");
  expect(formatDepthLore('Rhodes', '  the org ')).toBe('[Lore — Rhodes: the org]');
});

// ── buildInsertions ───────────────────────────────────────────────────────

test('buildInsertions returns nothing when empty', () => {
  expect(buildInsertions({})).toStrictEqual([]);
  expect(buildInsertions({ authorNote: '   ', lore: [] })).toStrictEqual([]);
});

test('buildInsertions emits lore then author note with default depth', () => {
  const ins = buildInsertions({ authorNote: 'be cool', lore: [{ name: 'RI', body: 'org', depth: 2 }] });
  expect(ins).toStrictEqual([
    { depth: 2, text: '[Lore — RI: org]' },
    { depth: DEFAULT_AUTHOR_NOTE_DEPTH, text: "[Author's note: be cool]" },
  ]);
});

test('buildInsertions honors an explicit author-note depth and skips empty lore bodies', () => {
  const ins = buildInsertions({
    authorNote: 'x',
    authorNoteDepth: 1,
    lore: [{ name: 'A', body: '   ', depth: 3 }],
  });
  expect(ins).toStrictEqual([{ depth: 1, text: "[Author's note: x]" }]);
});

// ── applyInsertions ───────────────────────────────────────────────────────

const msgs = ['m0', 'm1', 'm2', 'm3'];
const wrap = (text: string): string => `<${text}>`;

test('depth 0 appends at the very end', () => {
  expect(applyInsertions(msgs, [{ depth: 0, text: 'X' }], wrap)).toStrictEqual(['m0', 'm1', 'm2', 'm3', '<X>']);
});

test('depth 1 inserts before the last message', () => {
  expect(applyInsertions(msgs, [{ depth: 1, text: 'X' }], wrap)).toStrictEqual(['m0', 'm1', 'm2', '<X>', 'm3']);
});

test('depth clamps to the start when larger than the history', () => {
  expect(applyInsertions(msgs, [{ depth: 99, text: 'X' }], wrap)).toStrictEqual(['<X>', 'm0', 'm1', 'm2', 'm3']);
});

test('does not mutate the input array', () => {
  const original = [...msgs];
  applyInsertions(msgs, [{ depth: 2, text: 'X' }], wrap);
  expect(msgs).toStrictEqual(original);
});

test('empty insertions returns a copy unchanged', () => {
  const out = applyInsertions(msgs, [], wrap);
  expect(out).toStrictEqual(msgs);
  expect(out).not.toBe(msgs);
});

test('multiple insertions land at their respective depths in input order', () => {
  const out = applyInsertions(
    msgs,
    [
      { depth: 2, text: 'A' },
      { depth: 0, text: 'B' },
      { depth: 2, text: 'C' },
    ],
    wrap,
  );
  // depth 2 -> index 2 (before m2), depth 0 -> end. Same-index keeps order A then C.
  expect(out).toStrictEqual(['m0', 'm1', '<A>', '<C>', 'm2', 'm3', '<B>']);
});

test('applies into an empty history at depth 0', () => {
  expect(applyInsertions([], [{ depth: 0, text: 'X' }], wrap)).toStrictEqual(['<X>']);
});
