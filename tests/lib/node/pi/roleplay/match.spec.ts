/**
 * Tests for lib/node/pi/roleplay/match.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { hasKeyword, loreFires, matchLore } from '../../../../../lib/node/pi/roleplay/match.ts';
import { emptyLoreMeta, type LoreMeta, type RoleplayEntry } from '../../../../../lib/node/pi/roleplay/store.ts';

const lore = (id: string, meta: Partial<LoreMeta>): RoleplayEntry => ({
  id,
  kind: 'lore',
  name: id,
  description: `desc ${id}`,
  lore: { ...emptyLoreMeta(), ...meta },
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

test('hasKeyword needs no boundary on a side whose edge character is punctuation', () => {
  expect(hasKeyword('the R.I.s gathered', 'R.I.')).toBe(true);
  expect(hasKeyword('an x-ray film', 'x-')).toBe(true);
  expect(hasKeyword('a -tion suffix', '-tion')).toBe(true);
  expect(hasKeyword('motion', '-tion')).toBe(false);
  // The letter edge keeps its boundary.
  expect(hasKeyword('PR.I. memo', 'R.I.')).toBe(false);
  expect(hasKeyword('it is springtime', 'RI')).toBe(false);
});

test('hasKeyword is false for empty / whitespace keys', () => {
  expect(hasKeyword('anything', '   ')).toBe(false);
});

test('hasKeyword fires CJK keywords inside unspaced CJK text', () => {
  expect(hasKeyword('阿米娅说你好', '阿米娅')).toBe(true);
  expect(hasKeyword('博士和阿米娅说', '阿米娅')).toBe(true);
  expect(hasKeyword('ドクターが来た', 'ドクター')).toBe(true);
  expect(hasKeyword('こんにちは世界', 'こんにちは')).toBe(true);
  expect(hasKeyword('สวัสดีครับ', 'สวัสดี')).toBe(true);
  expect(hasKeyword('小王子', '阿米娅')).toBe(false);
});

test('hasKeyword treats an adjacent no-space-script char as a boundary for Latin keys', () => {
  expect(hasKeyword('罗德岛RI基地', 'RI')).toBe(true);
  expect(hasKeyword('springtime基地', 'RI')).toBe(false);
});

test('hasKeyword keeps strict boundaries for Hangul (space-delimited)', () => {
  expect(hasKeyword('아미야 안녕', '아미야')).toBe(true);
  expect(hasKeyword('아미야가 왔다', '아미야')).toBe(false);
});

test('hasKeyword treats combining marks as word characters', () => {
  expect(hasKeyword('le cafe\u0301 ouvert', 'cafe')).toBe(false);
  expect(hasKeyword('le cafe ouvert', 'cafe')).toBe(true);
});

test('hasKeyword escapes regex metacharacters in the keyword', () => {
  expect(hasKeyword('uses C++ daily', 'C++')).toBe(true);
  expect(hasKeyword('price is $5 (approx)', '$5 (approx)')).toBe(true);
  expect(hasKeyword('a.b.c', 'a*b')).toBe(false);
  expect(hasKeyword('the [x] marker', '[x]')).toBe(true);
  expect(hasKeyword('A-B route', 'A-B')).toBe(true);
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

test('secondary NOT_ALL suppresses only when every key is present', () => {
  const e = lore('ri', { triggers: ['Rhodes'], secondaryKeys: ['Reunion', 'Talulah'], secondaryMode: 'NOT_ALL' });
  expect(loreFires(e, 'Rhodes Island briefing')).toBe(true);
  expect(loreFires(e, 'Rhodes vs Reunion')).toBe(true);
  expect(loreFires(e, 'Rhodes vs Reunion and Talulah')).toBe(false);
});

test('enabled:false silences an entry, even a constant one', () => {
  expect(loreFires(lore('c', { constant: true, enabled: false }), 'anything')).toBe(false);
  expect(loreFires(lore('ri', { triggers: ['Rhodes'], enabled: false }), 'Rhodes Island')).toBe(false);
  // Default (enabled omitted / true) still fires.
  expect(loreFires(lore('ri2', { triggers: ['Rhodes'], enabled: true }), 'Rhodes Island')).toBe(true);
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
