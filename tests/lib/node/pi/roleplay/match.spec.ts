/**
 * Tests for lib/node/pi/roleplay/match.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { hasKeyword, loreFires, matchLore } from '../../../../../lib/node/pi/roleplay/match.ts';
import { type LoreMeta, type RoleplayEntry } from '../../../../../lib/node/pi/roleplay/store.ts';

const lore = (id: string, meta: Partial<LoreMeta>): RoleplayEntry => ({
  id,
  kind: 'lore',
  name: id,
  description: `desc ${id}`,
  lore: { triggers: [], secondaryKeys: [], secondaryMode: 'AND', constant: false, order: 0, recurse: false, ...meta },
});

// ── hasKeyword (word boundaries) ─────────────────────────────────────────

test('hasKeyword matches whole words case-insensitively', () => {
  expect(hasKeyword('Welcome to Rhodes Island.', 'rhodes island')).toBe(true);
  expect(hasKeyword('The DOCTOR arrives', 'doctor')).toBe(true);
});

test('hasKeyword does not match inside a longer word', () => {
  expect(hasKeyword('it is springtime', 'RI')).toBe(false);
  expect(hasKeyword('(RI) on patrol', 'RI')).toBe(true);
});

test('hasKeyword handles punctuation-bearing keys', () => {
  expect(hasKeyword("ask Dr. Kal'tsit about it", "Kal'tsit")).toBe(true);
});

test('hasKeyword is false for empty / whitespace keys', () => {
  expect(hasKeyword('anything', '   ')).toBe(false);
});

// ── loreFires ────────────────────────────────────────────────────────────

test('constant lore always fires regardless of text', () => {
  expect(loreFires(lore('c', { constant: true }), 'totally unrelated')).toBe(true);
});

test('primary triggers are OR-combined', () => {
  const e = lore('ri', { triggers: ['Rhodes Island', 'RI'] });
  expect(loreFires(e, 'meet at RI tonight')).toBe(true);
  expect(loreFires(e, 'a calm evening')).toBe(false);
});

test('lore with no triggers and not constant never fires', () => {
  expect(loreFires(lore('x', {}), 'Rhodes Island')).toBe(false);
});

test('secondary AND requires every key after a primary hit', () => {
  const e = lore('ri', { triggers: ['Rhodes'], secondaryKeys: ['Doctor', 'landship'], secondaryMode: 'AND' });
  expect(loreFires(e, 'Rhodes with the Doctor aboard the landship')).toBe(true);
  expect(loreFires(e, 'Rhodes with the Doctor')).toBe(false);
});

test('secondary OR requires at least one key', () => {
  const e = lore('ri', { triggers: ['Rhodes'], secondaryKeys: ['Doctor', 'Amiya'], secondaryMode: 'OR' });
  expect(loreFires(e, 'Rhodes and Amiya')).toBe(true);
  expect(loreFires(e, 'Rhodes alone')).toBe(false);
});

test('secondary NOT excludes when any key present', () => {
  const e = lore('ri', { triggers: ['Rhodes'], secondaryKeys: ['Reunion'], secondaryMode: 'NOT' });
  expect(loreFires(e, 'Rhodes Island briefing')).toBe(true);
  expect(loreFires(e, 'Rhodes vs Reunion')).toBe(false);
});

// ── matchLore ────────────────────────────────────────────────────────────

test('matchLore filters to fired lore and ignores non-lore + non-firing', () => {
  const entries: RoleplayEntry[] = [
    { id: 'exu', kind: 'character', name: 'Exusiai', description: 'sniper' },
    lore('ri', { triggers: ['Rhodes'] }),
    lore('pl', { triggers: ['Penguin Logistics'] }),
    lore('always', { constant: true }),
  ];
  const fired = matchLore(entries, 'A briefing at Rhodes Island.');
  expect(fired.map((e) => e.id).sort()).toStrictEqual(['always', 'ri']);
});
