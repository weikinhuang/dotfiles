/**
 * Tests for lib/node/pi/shared.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  byteLen,
  BYTE_ENCODER,
  sha256Hex,
  sha256HexPrefix,
  trimOrUndefined,
  truncate,
} from '../../../../lib/node/pi/shared.ts';

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
  // é is two bytes in UTF-8 — the digest matches the UTF-8 byte sequence,
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
