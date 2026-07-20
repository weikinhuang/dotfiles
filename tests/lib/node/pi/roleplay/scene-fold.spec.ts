/**
 * Tests for lib/node/pi/roleplay/scene-fold.ts (name-keyed character fold).
 *
 * Pure module - reuses the lore `hasKeyword` matcher + `applyTiming`
 * timing. Randomness is injected so probability-driven cases are stable.
 */

import { expect, test } from 'vitest';

import { characterKeys, characterMatches, planCharacterFold } from '../../../../../lib/node/pi/roleplay/scene-fold.ts';
import { type CharacterMeta, type RoleplayEntry } from '../../../../../lib/node/pi/roleplay/store.ts';

function char(id: string, name: string, meta?: Partial<CharacterMeta>): RoleplayEntry {
  const entry: RoleplayEntry = { id, kind: 'character', name, description: `${name} desc` };
  if (meta) {
    entry.character = {
      aliases: [],
      triggers: [],
      pinned: false,
      order: 0,
      sticky: 3,
      cooldown: 0,
      probability: 100,
      delay: 0,
      ...meta,
    };
  }
  return entry;
}

const always = (): number => 0; // probability rolls always pass

// ── keys + matching ────────────────────────────────────────────────────────

test('characterKeys is name-only by default, plus aliases + triggers, deduped', () => {
  expect(characterKeys(char('exusiai', 'Exusiai'))).toStrictEqual(['Exusiai']);
  const rich = char('kaltsit', 'Kaltsit', { aliases: ['Doctor', 'Exusiai'], triggers: ['the surgeon', 'Doctor'] });
  expect(characterKeys(rich)).toStrictEqual(['Kaltsit', 'Doctor', 'Exusiai', 'the surgeon']);
});

test('characterMatches is whole-word case-insensitive over all keys', () => {
  const e = char('kaltsit', 'Kaltsit', { aliases: ['the surgeon'] });
  expect(characterMatches(e, 'where is KALTSIT tonight?')).toBe(true);
  expect(characterMatches(e, 'call the surgeon, quick')).toBe(true);
  expect(characterMatches(e, 'no one relevant here')).toBe(false);
  // whole-word: "kalt" must not match inside a longer token
  expect(characterMatches(char('ri', 'Ri'), 'spring is here')).toBe(false);
});

// ── planCharacterFold ────────────────────────────────────────────────────────

test('a name mention folds the character in; an unmentioned one does not', () => {
  const entries = [char('exusiai', 'Exusiai'), char('texas', 'Texas')];
  const { firedIds } = planCharacterFold(entries, {
    scanText: 'Exusiai grins',
    turn: 1,
    priorTiming: {},
    rng: always,
  });
  expect(firedIds).toStrictEqual(['exusiai']);
});

test('pinned characters fold every turn regardless of mention, and are flagged', () => {
  const entries = [char('wei', 'Wei', { pinned: true }), char('texas', 'Texas')];
  const { firedIds, pinnedIds } = planCharacterFold(entries, {
    scanText: 'nobody named here',
    turn: 1,
    priorTiming: {},
    rng: always,
  });
  expect(firedIds).toStrictEqual(['wei']);
  expect(pinnedIds).toStrictEqual(['wei']);
});

test('non-character entries are ignored', () => {
  const entries: RoleplayEntry[] = [
    char('exusiai', 'Exusiai'),
    { id: 'exusiai', kind: 'lore', name: 'Exusiai', description: 'a lore dupe' },
  ];
  const { firedIds } = planCharacterFold(entries, {
    scanText: 'Exusiai',
    turn: 1,
    priorTiming: {},
    rng: always,
  });
  expect(firedIds).toStrictEqual(['exusiai']);
});

test('sticky window keeps a character folded after it stops being mentioned', () => {
  const entries = [char('kaya', 'Kaya', { sticky: 2 })];

  // Turn 1: mentioned -> folds + arms a sticky window.
  const t1 = planCharacterFold(entries, { scanText: 'hi Kaya', turn: 1, priorTiming: {}, rng: always });
  expect(t1.firedIds).toStrictEqual(['kaya']);

  // Turn 2: NOT mentioned, but sticky carries it.
  const t2 = planCharacterFold(entries, { scanText: 'weather talk', turn: 2, priorTiming: t1.nextTiming, rng: always });
  expect(t2.firedIds).toStrictEqual(['kaya']);

  // Turn 3: still within sticky (sticky=2 -> turns 2 and 3 carry).
  const t3 = planCharacterFold(entries, { scanText: 'more talk', turn: 3, priorTiming: t2.nextTiming, rng: always });
  expect(t3.firedIds).toStrictEqual(['kaya']);

  // Turn 4: sticky expired, no mention -> drops out.
  const t4 = planCharacterFold(entries, {
    scanText: 'still nothing',
    turn: 4,
    priorTiming: t3.nextTiming,
    rng: always,
  });
  expect(t4.firedIds).toStrictEqual([]);
});

test('delay makes a character ineligible to fold until the turn threshold', () => {
  const entries = [char('late', 'Late', { delay: 3 })];
  const early = planCharacterFold(entries, { scanText: 'Late arrives', turn: 1, priorTiming: {}, rng: always });
  expect(early.firedIds).toStrictEqual([]);
  const onTime = planCharacterFold(entries, { scanText: 'Late arrives', turn: 3, priorTiming: {}, rng: always });
  expect(onTime.firedIds).toStrictEqual(['late']);
});
