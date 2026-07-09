/**
 * Tests for lib/node/pi/shared.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  byteLen,
  BYTE_ENCODER,
  collapseWhitespace,
  formatCompactBytes,
  isFiniteNumber,
  isNonEmptyString,
  isRecord,
  isStringArray,
  sha256Hex,
  sha256HexPrefix,
  trimOrUndefined,
  truncate,
} from '../../../../lib/node/pi/shared.ts';

// ──────────────────────────────────────────────────────────────────────
// collapseWhitespace
// ──────────────────────────────────────────────────────────────────────

test('collapseWhitespace: collapses runs to single spaces', () => {
  expect(collapseWhitespace('a   b\tc')).toBe('a b c');
});

test('collapseWhitespace: trims leading and trailing whitespace', () => {
  expect(collapseWhitespace('  a\nb  ')).toBe('a b');
});

test('collapseWhitespace: returns empty string for whitespace-only input', () => {
  expect(collapseWhitespace('\n\t  ')).toBe('');
});

// ──────────────────────────────────────────────────────────────────────
// truncate
// ──────────────────────────────────────────────────────────────────────

test('truncate: returns input unchanged when shorter than n', () => {
  expect(truncate('hi', 10)).toBe('hi');
});

test('truncate: returns input unchanged when equal to n', () => {
  expect(truncate('hello', 5)).toBe('hello');
});

test('truncate: appends ellipsis when longer than n', () => {
  expect(truncate('hello world', 8)).toBe('hello w…');
});

test('truncate: final length equals n when truncating', () => {
  const out = truncate('abcdefghijklmnop', 10);

  expect(out).toHaveLength(10);
  expect(out.endsWith('…')).toBe(true);
});

test('truncate: n === 1 yields bare ellipsis for long inputs', () => {
  expect(truncate('hello', 1)).toBe('…');
});

test('truncate: n === 0 yields empty string', () => {
  expect(truncate('hello', 0)).toBe('');
});

test('truncate: negative n yields empty string', () => {
  expect(truncate('hello', -5)).toBe('');
});

test('truncate: { trim: true } strips whitespace before measuring', () => {
  expect(truncate('  hi  ', 10, { trim: true })).toBe('hi');
});

test('truncate: { trim: true } truncates the trimmed form', () => {
  expect(truncate('  hello world  ', 8, { trim: true })).toBe('hello w…');
});

test('truncate: without trim, leading whitespace counts toward length', () => {
  // '  hi' is 4 chars → fits under 5
  expect(truncate('  hi', 5)).toBe('  hi');
  // '  hello' is 7 chars; with n=5 → '  he…'
  expect(truncate('  hello', 5)).toBe('  he…');
});

test('truncate: empty string is returned as-is for any n >= 0', () => {
  expect(truncate('', 0)).toBe('');
  expect(truncate('', 5)).toBe('');
});

test('truncate: { collapseWhitespace: true } squeezes runs before measuring', () => {
  // 'a   b c' collapses to 'a b c' (5 chars) → fits under 10
  expect(truncate('a   b\tc', 10, { collapseWhitespace: true })).toBe('a b c');
});

test('truncate: { collapseWhitespace: true } truncates the collapsed form', () => {
  // '  hello   world  ' collapses to 'hello world' (11 chars); n=8 → 'hello w…'
  expect(truncate('  hello   world  ', 8, { collapseWhitespace: true })).toBe('hello w…');
});

test('truncate: { collapseWhitespace: true } takes precedence over trim', () => {
  expect(truncate('a\n\nb', 10, { collapseWhitespace: true, trim: true })).toBe('a b');
});

// ──────────────────────────────────────────────────────────────────────
// trimOrUndefined
// ──────────────────────────────────────────────────────────────────────

test('trimOrUndefined: returns trimmed value when non-empty', () => {
  expect(trimOrUndefined('  foo  ')).toBe('foo');
});

test('trimOrUndefined: returns undefined for whitespace-only input', () => {
  expect(trimOrUndefined('   ')).toBeUndefined();
  expect(trimOrUndefined('\t\n')).toBeUndefined();
});

test('trimOrUndefined: returns undefined for empty string', () => {
  expect(trimOrUndefined('')).toBeUndefined();
});

test('trimOrUndefined: returns undefined for undefined', () => {
  expect(trimOrUndefined(undefined)).toBeUndefined();
});

test('trimOrUndefined: rejects non-string input', () => {
  // @ts-expect-error intentionally passing a non-string
  expect(trimOrUndefined(42)).toBeUndefined();
  // @ts-expect-error intentionally passing a non-string
  expect(trimOrUndefined(null)).toBeUndefined();
});

// ──────────────────────────────────────────────────────────────────────
// byteLen / BYTE_ENCODER
// ──────────────────────────────────────────────────────────────────────

test('byteLen: ASCII matches char count', () => {
  expect(byteLen('hello')).toBe(5);
});

test('byteLen: multibyte UTF-8 counts bytes not code points', () => {
  // '…' is 3 bytes in UTF-8
  expect(byteLen('…')).toBe(3);
  // '🔥' is 4 bytes in UTF-8
  expect(byteLen('🔥')).toBe(4);
});

test('byteLen: empty string is 0', () => {
  expect(byteLen('')).toBe(0);
});

test('BYTE_ENCODER: is a reusable TextEncoder instance', () => {
  expect(BYTE_ENCODER).toBeInstanceOf(TextEncoder);
  expect(BYTE_ENCODER.encode('ab').length).toBe(2);
});

test('formatCompactBytes: renders B, KB, and MB without spaces', () => {
  expect(formatCompactBytes(0)).toBe('0B');
  expect(formatCompactBytes(1023)).toBe('1023B');
  expect(formatCompactBytes(50 * 1024)).toBe('50.0KB');
  expect(formatCompactBytes(5 * 1024 * 1024)).toBe('5.00MB');
});

// ───────────────────────────────────────────────────────────────────
// sha256 helpers
// ───────────────────────────────────────────────────────────────────

test('sha256Hex: returns 64-char lowercase hex for a known input', () => {
  // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('sha256Hex: is stable across calls on the same string input', () => {
  expect(sha256Hex('stable')).toBe(sha256Hex('stable'));
});

test('sha256Hex: distinguishes different inputs', () => {
  expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
});

test('sha256Hex: accepts Buffer inputs and matches the equivalent string', () => {
  const buf = Buffer.from('hello', 'utf8');

  expect(sha256Hex(buf)).toBe(sha256Hex('hello'));
});

test('sha256Hex: treats string inputs as UTF-8 (multibyte)', () => {
  // é is two bytes in UTF-8 - the digest matches the UTF-8 byte sequence,
  // not any other encoding. Regression-guard for a future "helpful"
  // change to e.g. Latin-1.
  expect(sha256Hex('é')).toBe(sha256Hex(Buffer.from([0xc3, 0xa9])));
});

test('sha256HexPrefix: returns the first n chars of the full digest', () => {
  const full = sha256Hex('hello');

  expect(sha256HexPrefix('hello', 12)).toBe(full.slice(0, 12));
  expect(sha256HexPrefix('hello', 1)).toBe(full.slice(0, 1));
  expect(sha256HexPrefix('hello', 64)).toBe(full);
});

test('sha256HexPrefix: rejects out-of-range n with RangeError', () => {
  expect(() => sha256HexPrefix('x', 0)).toThrow(RangeError);
  expect(() => sha256HexPrefix('x', -1)).toThrow(RangeError);
  expect(() => sha256HexPrefix('x', 65)).toThrow(RangeError);
  expect(() => sha256HexPrefix('x', 1.5)).toThrow(RangeError);
  expect(() => sha256HexPrefix('x', Number.NaN)).toThrow(RangeError);
});

// ──────────────────────────────────────────────────────────────────────
// isRecord
// ──────────────────────────────────────────────────────────────────────

test('isRecord: true for plain objects', () => {
  expect(isRecord({})).toBe(true);
  expect(isRecord({ a: 1 })).toBe(true);
});

test('isRecord: true for class instances and null-proto objects', () => {
  // Loose record check - accepts anything object-shaped that isn't an
  // array. Callers that need to reject class instances roll their own
  // strict variant (see request-options.ts).
  class C {}
  expect(isRecord(new C())).toBe(true);
  expect(isRecord(Object.create(null))).toBe(true);
});

test('isRecord: false for arrays, null, primitives, functions', () => {
  expect(isRecord([])).toBe(false);
  expect(isRecord(null)).toBe(false);
  expect(isRecord(undefined)).toBe(false);
  expect(isRecord('s')).toBe(false);
  expect(isRecord(1)).toBe(false);
  expect(isRecord(() => 0)).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// isStringArray
// ──────────────────────────────────────────────────────────────────────

test('isStringArray: true for empty array', () => {
  expect(isStringArray([])).toBe(true);
});

test('isStringArray: true for all-string arrays (including empty strings)', () => {
  expect(isStringArray(['a', 'b'])).toBe(true);
  expect(isStringArray([''])).toBe(true);
});

test('isStringArray: false when any element is non-string', () => {
  expect(isStringArray(['a', 1])).toBe(false);
  expect(isStringArray([null])).toBe(false);
  expect(isStringArray([undefined])).toBe(false);
});

test('isStringArray: false for non-arrays', () => {
  expect(isStringArray('abc')).toBe(false);
  expect(isStringArray({ 0: 'a', length: 1 })).toBe(false);
  expect(isStringArray(null)).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// isNonEmptyString
// ──────────────────────────────────────────────────────────────────────

test('isNonEmptyString: true only for strings with at least one char', () => {
  expect(isNonEmptyString('a')).toBe(true);
  expect(isNonEmptyString(' ')).toBe(true);
});

test('isNonEmptyString: false for empty string and non-string values', () => {
  expect(isNonEmptyString('')).toBe(false);
  expect(isNonEmptyString(undefined)).toBe(false);
  expect(isNonEmptyString(null)).toBe(false);
  expect(isNonEmptyString(0)).toBe(false);
  expect(isNonEmptyString({})).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// isFiniteNumber
// ──────────────────────────────────────────────────────────────────────

test('isFiniteNumber: true for real finite numbers (including zero and negatives)', () => {
  expect(isFiniteNumber(0)).toBe(true);
  expect(isFiniteNumber(42)).toBe(true);
  expect(isFiniteNumber(-3.14)).toBe(true);
});

test('isFiniteNumber: false for NaN, Infinity, non-numbers', () => {
  expect(isFiniteNumber(Number.NaN)).toBe(false);
  expect(isFiniteNumber(Infinity)).toBe(false);
  expect(isFiniteNumber(-Infinity)).toBe(false);
  expect(isFiniteNumber('5')).toBe(false);
  expect(isFiniteNumber(null)).toBe(false);
  expect(isFiniteNumber(undefined)).toBe(false);
});
