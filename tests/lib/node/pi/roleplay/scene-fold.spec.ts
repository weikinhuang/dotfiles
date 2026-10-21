/**
 * Tests for lib/node/pi/roleplay/scene-fold.ts (name-keyed character fold).
 *
 * Pure module - reuses the lore `hasKeyword` matcher + `applyTiming`
 * timing. Randomness is injected so probability-driven cases are stable.
 */

import { expect, test } from 'vitest';

import {
  characterKeys,
  characterMatches,
  planCharacterFold,
  rankByCharacterOrder,
  selectFoldDeliveries,
} from '../../../../../lib/node/pi/roleplay/scene-fold.ts';
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

// ── delivery selection (reminder mode) ────────────────────────────────────

test('selectFoldDeliveries sends a newly active sheet, skips a sticky one until the refresh', () => {
  const base = { refreshTurns: 3, lastDelivered: new Map([['a', 5]]) };
  // `a` entered this turn -> deliver even though delivered recently.
  expect(selectFoldDeliveries({ ...base, activeIds: ['a'], priorActiveIds: new Set(), turn: 6 })).toStrictEqual(['a']);
  // Still active, delivered 1-2 turns ago -> skip.
  expect(selectFoldDeliveries({ ...base, activeIds: ['a'], priorActiveIds: new Set(['a']), turn: 6 })).toStrictEqual(
    [],
  );
  expect(selectFoldDeliveries({ ...base, activeIds: ['a'], priorActiveIds: new Set(['a']), turn: 7 })).toStrictEqual(
    [],
  );
  // Refresh boundary reached.
  expect(selectFoldDeliveries({ ...base, activeIds: ['a'], priorActiveIds: new Set(['a']), turn: 8 })).toStrictEqual([
    'a',
  ]);
});

test('selectFoldDeliveries delivers a never-delivered active id, keeps order, dedups', () => {
  expect(
    selectFoldDeliveries({
      activeIds: ['b', 'a', 'b', 'c'],
      priorActiveIds: new Set(['a', 'b', 'c']),
      lastDelivered: new Map([['a', 9]]),
      turn: 10,
      refreshTurns: 6,
    }),
  ).toStrictEqual(['b', 'c']);
});

test('selectFoldDeliveries floors refreshTurns at 1 (every turn)', () => {
  expect(
    selectFoldDeliveries({
      activeIds: ['a'],
      priorActiveIds: new Set(['a']),
      lastDelivered: new Map([['a', 4]]),
      turn: 5,
      refreshTurns: 0,
    }),
  ).toStrictEqual(['a']);
});

// ── order ranking ────────────────────────────────────────────────────────────

test('rankByCharacterOrder sorts by order descending and keeps input order on ties', () => {
  const orderOf = new Map([
    ['a', 0],
    ['b', 5],
    ['c', 0],
    ['d', 5],
  ]);
  expect(rankByCharacterOrder(['a', 'b', 'c', 'd', 'unknown'], orderOf)).toStrictEqual(['b', 'd', 'a', 'c', 'unknown']);
  expect(rankByCharacterOrder(['x', 'y'], new Map())).toStrictEqual(['x', 'y']);
});

test('planCharacterFold ranks each tier by order so higher order survives tail eviction', () => {
  const entries = [
    char('alpha', 'Alpha', { pinned: true }),
    char('beta', 'Beta', { pinned: true, order: 10 }),
    char('gamma', 'Gamma'),
    char('delta', 'Delta', { order: 3 }),
    char('eps', 'Eps', { order: -1 }),
  ];
  const { firedIds, pinnedIds } = planCharacterFold(entries, {
    scanText: 'Gamma, Delta and Eps arrive',
    turn: 1,
    priorTiming: {},
    rng: always,
  });
  expect(pinnedIds).toStrictEqual(['beta', 'alpha']);
  expect(firedIds.filter((id) => !pinnedIds.includes(id))).toStrictEqual(['delta', 'gamma', 'eps']);
});
