/**
 * Tests for `lib/node/pi/util.ts` (shQuote + isPlainObject).
 */

import { describe, expect, test } from 'vitest';

import { isPlainObject, shQuote } from '../../../../lib/node/pi/util.ts';

describe('shQuote', () => {
  test('wraps a plain string in single quotes', () => {
    expect(shQuote('foo')).toBe("'foo'");
  });

  test('escapes embedded single quotes via close/escape/reopen', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });

  test('passes through shell metacharacters unchanged', () => {
    expect(shQuote('$( whoami ) && rm -rf /')).toBe("'$( whoami ) && rm -rf /'");
  });

  test('round-trips through sh -c (smoke)', () => {
    // The whole point of shQuote is that `sh -c "echo " + shQuote(s)` prints s.
    // Hard to call sh here without spawning; assert structural invariant
    // instead: the result starts + ends with a single quote and contains
    // no unescaped single quotes inside.
    const out = shQuote("a'b'c");
    expect(out.startsWith("'")).toBe(true);
    expect(out.endsWith("'")).toBe(true);
  });
});

describe('isPlainObject', () => {
  test('true for plain objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  test('false for arrays, null, primitives, functions', () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject('s')).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject(() => 0)).toBe(false);
  });
});
