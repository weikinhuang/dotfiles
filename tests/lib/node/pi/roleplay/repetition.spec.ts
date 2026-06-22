/**
 * Tests for lib/node/pi/roleplay/repetition.ts - n-gram normalization,
 * cross-reply detection, character-sheet exclusion, and nudge framing.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  buildExcludeSet,
  detectRepetition,
  formatRepetitionNudge,
  ngrams,
  normalizeWords,
} from '../../../../../lib/node/pi/roleplay/repetition.ts';

test('normalizeWords lowercases and strips markdown + punctuation', () => {
  expect(normalizeWords('*I lean back.*')).toEqual(['i', 'lean', 'back']);
  expect(normalizeWords('"You made **this**?"')).toEqual(['you', 'made', 'this']);
  expect(normalizeWords('   ')).toEqual([]);
});

test('ngrams produces contiguous windows and clamps tiny n', () => {
  expect(ngrams(['a', 'b', 'c'], 2)).toEqual(['a b', 'b c']);
  expect(ngrams(['a', 'b'], 5)).toEqual([]);
  // n is floored to a minimum of 2.
  expect(ngrams(['a', 'b', 'c'], 1)).toEqual(['a b', 'b c']);
});

test('detectRepetition flags a phrase repeated across replies', () => {
  const replies = ['a shiver runs down my spine as I wait', 'later, a shiver runs down my spine again'];
  const phrases = detectRepetition(replies, new Set(), { ngram: 5, window: 6, minCount: 2 });
  expect(phrases).toContain('a shiver runs down my');
});

test('detectRepetition respects the exclusion set (signature phrases)', () => {
  const replies = ['I swear on this gun in my hand', 'once more, I swear on this gun in my hand'];
  const exclude = buildExcludeSet(['I swear on this gun in my hand, savior'], 5);
  expect(detectRepetition(replies, exclude, { ngram: 5, window: 6, minCount: 2 })).toEqual([]);
});

test('detectRepetition returns nothing when no phrase repeats', () => {
  const replies = ['the morning light spills across the floor', 'we walk to the harbor in silence'];
  expect(detectRepetition(replies, new Set(), { ngram: 5, window: 6, minCount: 2 })).toEqual([]);
});

test('detectRepetition only scans the most-recent window', () => {
  const replies = [
    'the same exact phrase repeated here',
    'the same exact phrase repeated here',
    'a completely different unrelated closing line',
  ];
  // Window of 1 sees only the last reply -> no cross-reply repeat.
  expect(detectRepetition(replies, new Set(), { ngram: 4, window: 1, minCount: 2 })).toEqual([]);
});

test('detectRepetition floors minCount to 2', () => {
  const replies = ['unique line one here now', 'unique line two there then'];
  // minCount 1 would flag every n-gram; the floor prevents that.
  expect(detectRepetition(replies, new Set(), { ngram: 4, window: 6, minCount: 1 })).toEqual([]);
});

test('formatRepetitionNudge lists phrases or returns null when empty', () => {
  expect(formatRepetitionNudge([])).toBeNull();
  const nudge = formatRepetitionNudge(['a b c d e', 'f g h i j', 'k l m n o', 'p q r s t'], 3);
  expect(nudge).not.toBeNull();
  expect(nudge).toContain('"a b c d e"');
  expect(nudge).toContain('"k l m n o"');
  // Capped at the limit.
  expect(nudge).not.toContain('"p q r s t"');
});
