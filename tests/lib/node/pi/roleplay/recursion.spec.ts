/**
 * Tests for lib/node/pi/roleplay/recursion.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { expandRecursive, MAX_RECURSION_CAP } from '../../../../../lib/node/pi/roleplay/recursion.ts';
import { type LoreMeta, type RoleplayEntry } from '../../../../../lib/node/pi/roleplay/store.ts';

const lore = (id: string, meta: Partial<LoreMeta>, body = ''): { entry: RoleplayEntry; body: string } => ({
  entry: {
    id,
    kind: 'lore',
    name: id,
    description: `desc ${id}`,
    lore: { triggers: [], secondaryKeys: [], secondaryMode: 'AND', constant: false, order: 0, recurse: false, ...meta },
  },
  body,
});

function fixture(): { all: RoleplayEntry[]; bodyOf: (e: RoleplayEntry) => string } {
  // a (recurse, body mentions "Beta") -> b (recurse, body mentions "Gamma") -> c
  const records = [
    lore('a', { triggers: ['Alpha'], recurse: true }, 'Alpha leads to Beta.'),
    lore('b', { triggers: ['Beta'], recurse: true }, 'Beta leads to Gamma.'),
    lore('c', { triggers: ['Gamma'], recurse: false }, 'Gamma is the end.'),
  ];
  const all = records.map((r) => r.entry);
  const bodyOf = (e: RoleplayEntry): string => records.find((r) => r.entry.id === e.id)?.body ?? '';
  return { all, bodyOf };
}

test('no recursion (maxRecursion 0) returns only the initial fired set', () => {
  const { all, bodyOf } = fixture();
  const initial = [all[0]];
  const out = expandRecursive(initial, all, { bodyOf, maxRecursion: 0 });
  expect(out.map((e) => e.id)).toStrictEqual(['a']);
});

test('one pass fires the directly-referenced entry', () => {
  const { all, bodyOf } = fixture();
  const out = expandRecursive([all[0]], all, { bodyOf, maxRecursion: 1 });
  expect(out.map((e) => e.id).sort()).toStrictEqual(['a', 'b']);
});

test('two passes chain through recurse-enabled bodies', () => {
  const { all, bodyOf } = fixture();
  const out = expandRecursive([all[0]], all, { bodyOf, maxRecursion: 2 });
  expect(out.map((e) => e.id).sort()).toStrictEqual(['a', 'b', 'c']);
});

test('a non-recursing fired entry does not seed further passes', () => {
  // c fires but is recurse:false; its body mentioning others must not expand.
  const records = [
    lore('c', { triggers: ['Gamma'], recurse: false }, 'Gamma mentions Delta.'),
    lore('d', { triggers: ['Delta'], recurse: false }, 'end'),
  ];
  const all = records.map((r) => r.entry);
  const bodyOf = (e: RoleplayEntry): string => records.find((r) => r.entry.id === e.id)?.body ?? '';
  const out = expandRecursive([all[0]], all, { bodyOf, maxRecursion: 2 });
  expect(out.map((e) => e.id)).toStrictEqual(['c']);
});

test('maxRecursion is clamped to MAX_RECURSION_CAP', () => {
  expect(MAX_RECURSION_CAP).toBe(2);
  const { all, bodyOf } = fixture();
  // Requesting 99 passes must not exceed the cap (only a,b,c exist anyway).
  const out = expandRecursive([all[0]], all, { bodyOf, maxRecursion: 99 });
  expect(out.map((e) => e.id).sort()).toStrictEqual(['a', 'b', 'c']);
});
