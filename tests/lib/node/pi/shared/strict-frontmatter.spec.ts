/**
 * Tests for lib/node/pi/shared/strict-frontmatter.ts.
 *
 * Pure module - no pi runtime needed. Pins the fence-parsing behavior the
 * memory and roleplay stores both build on. The header itself is parsed
 * by the real `yaml` package, so block scalars, wrapped values, inline
 * lists, and native types (numbers / booleans / arrays) all behave per
 * the YAML 1.2 core schema.
 */

import { expect, test } from 'vitest';

import { parseFencedFrontmatter } from '../../../../../lib/node/pi/shared/strict-frontmatter.ts';

// ── rejection cases ────────────────────────────────────────────────────────

test('returns null when there is no opening fence', () => {
  expect(parseFencedFrontmatter('just a body\n')).toBeNull();
  // Non-whitespace content before the fence is still not tolerated.
  expect(parseFencedFrontmatter('nope\n---\nname: n\n---\n')).toBeNull();
});

test('returns null on an unterminated fence', () => {
  expect(parseFencedFrontmatter('---\nname: n\n')).toBeNull();
});

test('returns null when the header is not valid YAML (a colon-less line)', () => {
  // `name: n` followed by a bare `bogusline` is a YAML syntax error;
  // the whole file is rejected rather than throwing.
  expect(parseFencedFrontmatter('---\nname: n\nbogusline\n---\nbody')).toBeNull();
});

test('returns null on duplicate keys (a YAML parse error)', () => {
  expect(parseFencedFrontmatter('---\ntype: first\ntype: second\n---\n')).toBeNull();
});

test('returns null when the header parses to a bare scalar (not a mapping)', () => {
  expect(parseFencedFrontmatter('---\njust a scalar\n---\nbody\n')).toBeNull();
});

test('returns null when the header parses to a sequence (not a mapping)', () => {
  expect(parseFencedFrontmatter('---\n- a\n- b\n---\nbody\n')).toBeNull();
});

// ── leading-noise tolerance ────────────────────────────────────────────────

test('tolerates a leading UTF-8 BOM before the opening fence', () => {
  const parsed = parseFencedFrontmatter('\uFEFF---\nname: n\n---\nbody\n');
  expect(parsed).not.toBeNull();
  expect(parsed!.fields.name).toBe('n');
  expect(parsed!.body).toBe('body\n');
});

test('tolerates leading whitespace / blank lines before the opening fence', () => {
  const spaced = parseFencedFrontmatter('  ---\nname: n\n---\nbody\n');
  expect(spaced!.fields.name).toBe('n');

  const blankLines = parseFencedFrontmatter('\n\n---\nname: n\n---\nbody\n');
  expect(blankLines!.fields.name).toBe('n');
});

// ── header parsing (real YAML) ─────────────────────────────────────────────

test('parses key: value pairs into unquoted, typed values', () => {
  const parsed = parseFencedFrontmatter('---\nname: Alice\ndescription: a preference\n---\nbody\n');
  expect(parsed).not.toBeNull();
  expect(parsed!.fields.name).toBe('Alice');
  expect(parsed!.fields.description).toBe('a preference');
});

test('carries native YAML types through (number / boolean / array)', () => {
  const parsed = parseFencedFrontmatter('---\norder: 5\nconstant: true\ntriggers: [a, b, c]\n---\n');
  expect(parsed!.fields.order).toBe(5);
  expect(parsed!.fields.constant).toBe(true);
  expect(parsed!.fields.triggers).toEqual(['a', 'b', 'c']);
});

test('unquotes a value that itself contains a colon', () => {
  const parsed = parseFencedFrontmatter('---\nname: "has: a colon"\n---\n');
  expect(parsed!.fields.name).toBe('has: a colon');
});

test('keeps a full URL value intact', () => {
  const parsed = parseFencedFrontmatter('---\nurl: http://example.com\n---\n');
  expect(parsed!.fields.url).toBe('http://example.com');
});

test('parses a block scalar (|) preserving internal newlines', () => {
  const parsed = parseFencedFrontmatter('---\nname: n\nappend: |\n  line one\n  line two\n---\nbody\n');
  expect(parsed).not.toBeNull();
  expect(parsed!.fields.append).toBe('line one\nline two\n');
});

test('parses a value wrapped across indented continuation lines', () => {
  // What a markdown/YAML formatter produces when re-wrapping a long value.
  const parsed = parseFencedFrontmatter(
    '---\ndescription:\n  a long value that\n  wraps onto lines\nname: n\n---\nbody\n',
  );
  expect(parsed!.fields.description).toBe('a long value that wraps onto lines');
  expect(parsed!.fields.name).toBe('n');
});

test('parses an empty header (no fields) with a body', () => {
  const parsed = parseFencedFrontmatter('---\n---\nbody\n');
  expect(parsed).not.toBeNull();
  expect(parsed!.fields).toEqual({});
  expect(parsed!.body).toBe('body\n');
});

// ── body slicing ───────────────────────────────────────────────────────────

test('normalises CRLF to LF', () => {
  const parsed = parseFencedFrontmatter('---\r\nname: n\r\n---\r\n\r\nbody\r\n');
  expect(parsed).not.toBeNull();
  expect(parsed!.fields.name).toBe('n');
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
