/**
 * Tests for lib/node/pi/roleplay/text.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { clampWords } from '../../../../../lib/node/pi/roleplay/text.ts';

test('clampWords returns collapsed input unchanged when within the cap', () => {
  expect(clampWords('  a   b  ', 20)).toBe('a b');
});

test('clampWords backs up to a whole word when the cap lands mid-word', () => {
  // "the courier delive|rs" -> back up to "the courier".
  expect(clampWords('the courier delivers a letter', 18)).toBe('the courier');
});

test('clampWords keeps the whole word when the cap falls on a space', () => {
  // Cap at a space boundary should not trim the preceding word away.
  expect(clampWords('one two three', 7)).toBe('one two');
});

test('clampWords strips trailing separators after backing up', () => {
  expect(clampWords('berries, whipped cream', 12)).toBe('berries');
});
