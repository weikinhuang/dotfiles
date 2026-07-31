/**
 * Tests for lib/node/pi/roleplay/text.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { clampWords, normalizeInjectedBody } from '../../../../../lib/node/pi/roleplay/text.ts';

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

// ── normalizeInjectedBody ────────────────────────────────────────────────

test('normalizeInjectedBody collapses blank-line runs but keeps paragraphs', () => {
  expect(normalizeInjectedBody('para one\n\n\n\n\npara two')).toBe('para one\n\npara two');
  // A single blank line (one paragraph break) is preserved as-is.
  expect(normalizeInjectedBody('a\n\nb')).toBe('a\n\nb');
});

test('normalizeInjectedBody strips per-line trailing whitespace and trims ends', () => {
  expect(normalizeInjectedBody('  \n\nline one   \nline two\t\n\n  ')).toBe('line one\nline two');
});

test('normalizeInjectedBody returns empty for a whitespace-only body', () => {
  expect(normalizeInjectedBody('   \n\t\n   ')).toBe('');
  expect(normalizeInjectedBody('')).toBe('');
});
