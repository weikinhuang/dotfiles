/**
 * Tests for lib/node/pi/fuzzy-match.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import { fuzzyMatch } from '../../../../lib/node/pi/fuzzy-match.ts';

describe('fuzzyMatch - subsequence matching', () => {
  test('empty pattern matches everything with score 0', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch('', '')).toEqual({ score: 0, indices: [] });
  });

  test('subsequence match returns indices in order', () => {
    const m = fuzzyMatch('gst', 'git status');
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 4, 5]);
  });

  test('non-matching pattern returns null', () => {
    expect(fuzzyMatch('xyz', 'git status')).toBeNull();
    expect(fuzzyMatch('cat', 'git')).toBeNull();
  });

  test('pattern longer than text where last char missing returns null', () => {
    expect(fuzzyMatch('gits', 'git')).toBeNull();
  });

  test('exact match also matches', () => {
    const m = fuzzyMatch('hello', 'hello');
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 1, 2, 3, 4]);
  });

  test('first matching subsequence wins (left-to-right greedy)', () => {
    // "foo" appears twice; we should pick the first one.
    const m = fuzzyMatch('foo', 'foobar foo');
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 1, 2]);
  });
});

describe('fuzzyMatch - case sensitivity', () => {
  test('case-insensitive by default', () => {
    expect(fuzzyMatch('git', 'GIT')).not.toBeNull();
    expect(fuzzyMatch('GIT', 'git')).not.toBeNull();
  });

  test('case-exact match scores higher than case-insensitive', () => {
    const exact = fuzzyMatch('git', 'git')!;
    const mixed = fuzzyMatch('git', 'GIT')!;
    expect(exact.score).toBeGreaterThan(mixed.score);
  });
});

describe('fuzzyMatch - scoring', () => {
  test('consecutive run scores higher than spread-out match', () => {
    const consecutive = fuzzyMatch('abc', 'abcxxxxxx')!;
    const spread = fuzzyMatch('abc', 'a-b-c-xxx')!;
    expect(consecutive.score).toBeGreaterThan(spread.score);
  });

  test('match at start of word scores higher than match mid-word', () => {
    // "gs" at the start of two words ("git status") vs mid-word.
    const wordStart = fuzzyMatch('gs', 'git status')!;
    const midWord = fuzzyMatch('it', 'gitator')!;
    // wordStart matches `g` at index 0 and `s` at index 4 (after space).
    // midWord matches mid-word at indices 1, 2.
    expect(wordStart.score).toBeGreaterThan(midWord.score);
  });

  test('ranks better-matching texts higher when used to sort', () => {
    const inputs = ['git status', 'gentleman starts', 'github release', 'general settings'];
    const scored = inputs
      .map((text) => ({ text, m: fuzzyMatch('gs', text) }))
      .filter((x): x is { text: string; m: NonNullable<typeof x.m> } => x.m !== null)
      .sort((a, b) => b.m.score - a.m.score);
    // All four match. The two with 'g' at index 0 and 's' at the start of
    // a later word should top the ranking.
    expect(scored[0].text === 'git status' || scored[0].text === 'general settings').toBe(true);
  });
});
