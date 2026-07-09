/**
 * Tests for lib/node/pi/shared/strict-frontmatter.ts.
 *
 * Pure module - no pi runtime needed. Pins the mechanical fence-parsing
 * behavior the memory and roleplay stores both build on.
 */

import { expect, test } from 'vitest';

import { parseFencedFrontmatter, stripQuotes } from '../../../../../lib/node/pi/shared/strict-frontmatter.ts';

// ── stripQuotes ───────────────────────────────────────────────────────────

test('stripQuotes: leaves an unquoted value trimmed', () => {
  expect(stripQuotes('  hello  ')).toBe('hello');
});

test('stripQuotes: unwraps a matched double-quote pair and reverses escapes', () => {
  expect(stripQuotes('"a\\\\b\\"c"')).toBe('a\\b"c');
});

test('stripQuotes: unwraps a matched single-quote pair literally', () => {
  expect(stripQuotes("'a: b # c'")).toBe('a: b # c');
});

test('stripQuotes: leaves a lone / mismatched quote as-is (trimmed)', () => {
  expect(stripQuotes('"unterminated')).toBe('"unterminated');
  expect(stripQuotes('  no quotes: here  ')).toBe('no quotes: here');
});

// ── parseFencedFrontmatter: rejection cases ────────────────────────────────

test('returns null when there is no opening fence', () => {
  expect(parseFencedFrontmatter('just a body\n')).toBeNull();
  // Leading whitespace before the fence is not tolerated.
  expect(parseFencedFrontmatter('  ---\nname: n\n---\n')).toBeNull();
});

test('returns null on an unterminated fence', () => {
  expect(parseFencedFrontmatter('---\nname: n\n')).toBeNull();
});

test('returns null when a non-blank header line lacks a colon', () => {
  expect(parseFencedFrontmatter('---\nname: n\nbogusline\n---\nbody')).toBeNull();
});

// ── parseFencedFrontmatter: field parsing ──────────────────────────────────

test('parses key: value pairs, trimming keys and keeping values verbatim', () => {
  const parsed = parseFencedFrontmatter('---\n  name : Alice \ndescription: a preference\n---\nbody\n');
  expect(parsed).not.toBeNull();
  // Trailing whitespace on the line is stripped, but the value keeps its
  // leading space after the colon (verbatim, not quote-stripped).
  expect(parsed!.fields.name).toBe(' Alice');
  expect(parsed!.fields.description).toBe(' a preference');
});

test('splits on the first colon only, keeping later colons in the value', () => {
  const parsed = parseFencedFrontmatter('---\nurl: http://example.com\n---\n');
  expect(parsed!.fields.url).toBe(' http://example.com');
});

test('keeps quotes verbatim in the field map (stripping is the caller job)', () => {
  const parsed = parseFencedFrontmatter('---\nname: "has: a colon"\n---\n');
  expect(parsed!.fields.name).toBe(' "has: a colon"');
  expect(stripQuotes(parsed!.fields.name)).toBe('has: a colon');
});

test('skips blank header lines', () => {
  const parsed = parseFencedFrontmatter('---\nname: n\n\n   \ndescription: d\n---\nbody');
  expect(parsed).not.toBeNull();
  expect(Object.keys(parsed!.fields)).toEqual(['name', 'description']);
});

test('later duplicate keys overwrite earlier ones (last wins)', () => {
  const parsed = parseFencedFrontmatter('---\ntype: first\ntype: second\n---\n');
  expect(parsed!.fields.type).toBe(' second');
});

// ── parseFencedFrontmatter: body slicing ───────────────────────────────────

test('normalises CRLF to LF', () => {
  const parsed = parseFencedFrontmatter('---\r\nname: n\r\n---\r\n\r\nbody\r\n');
  expect(parsed).not.toBeNull();
  expect(parsed!.fields.name).toBe(' n');
  expect(parsed!.body.trim()).toBe('body');
});

test('strips leading blank lines from the body', () => {
  const parsed = parseFencedFrontmatter('---\nname: n\n---\n\n\nbody text\n');
  expect(parsed!.body).toBe('body text\n');
});

test('yields an empty body when the file ends exactly with \\n---', () => {
  const parsed = parseFencedFrontmatter('---\nname: n\n---');
  expect(parsed).not.toBeNull();
  expect(parsed!.body).toBe('');
});

test('yields an empty body when nothing follows the closing fence', () => {
  const parsed = parseFencedFrontmatter('---\nname: n\n---\n');
  expect(parsed).not.toBeNull();
  expect(parsed!.body).toBe('');
});

test('preserves a --- rule inside the body (scan stops at the first close)', () => {
  const parsed = parseFencedFrontmatter('---\nname: n\n---\nintro\n\n---\n\nmore: text\n');
  expect(parsed).not.toBeNull();
  expect(parsed!.body).toBe('intro\n\n---\n\nmore: text\n');
});

test('parses an empty header (no fields) with a body', () => {
  const parsed = parseFencedFrontmatter('---\n---\nbody\n');
  expect(parsed).not.toBeNull();
  expect(parsed!.fields).toEqual({});
  expect(parsed!.body).toBe('body\n');
});
