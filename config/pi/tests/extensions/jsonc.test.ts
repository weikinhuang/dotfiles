/**
 * Tests for config/pi/extensions/lib/jsonc.ts.
 *
 * Run:  node --test config/pi/tests/extensions/jsonc.test.ts
 *   or: cd config/pi/tests && node --test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsonc, stripJsonComments } from '../../extensions/lib/jsonc.ts';

// ──────────────────────────────────────────────────────────────────────
// stripJsonComments
// ──────────────────────────────────────────────────────────────────────

test('stripJsonComments: pure JSON passes through unchanged', () => {
  const src = '{"a": 1, "b": [2, 3]}';
  assert.equal(stripJsonComments(src), src);
});

test('stripJsonComments: drops // line comments', () => {
  assert.equal(stripJsonComments('{\n  "a": 1 // a trailing comment\n}'), '{\n  "a": 1 \n}');
  assert.equal(stripJsonComments('// header line\n{"a": 1}'), '\n{"a": 1}');
});

test('stripJsonComments: drops /* */ block comments', () => {
  assert.equal(stripJsonComments('{"a": /* inline */ 1}'), '{"a":  1}');
});

test('stripJsonComments: block comments preserve embedded newlines', () => {
  // Critical for parse-error line numbers to still point at the right
  // line of the original source after stripping.
  const src = '{\n  /* this\n     spans\n     lines */\n  "a": 1\n}';
  const out = stripJsonComments(src);
  // Three embedded newlines inside the block comment must survive.
  const originalNewlines = (src.match(/\n/g) ?? []).length;
  const strippedNewlines = (out.match(/\n/g) ?? []).length;
  assert.equal(strippedNewlines, originalNewlines);
});

test('stripJsonComments: // and /* inside strings are NOT stripped', () => {
  // The canonical footgun: URLs inside JSON strings.
  assert.equal(stripJsonComments('{"url": "https://example.com/path"}'), '{"url": "https://example.com/path"}');
  // Block-comment-looking substrings inside strings.
  assert.equal(stripJsonComments('{"pattern": "/* not a comment */"}'), '{"pattern": "/* not a comment */"}');
  // Adjacent to a real comment.
  assert.equal(stripJsonComments('{"url": "https://ex.com"} // real comment'), '{"url": "https://ex.com"} ');
});

test('stripJsonComments: escaped quotes do not end strings early', () => {
  // `"a\"b // not a comment"` — the escaped quote keeps us inside the string.
  const src = '{"s": "a\\"b // still inside"}';
  assert.equal(stripJsonComments(src), src);
});

test('stripJsonComments: backslash-quote pairs inside a string', () => {
  // `{"s": "\\"}` — a single backslash then end-of-string. Must round-trip.
  const src = '{"s": "\\\\"}';
  assert.equal(stripJsonComments(src), src);
  // And the parsed value is the single-char backslash.
  assert.equal(parseJsonc<{ s: string }>(src).s, '\\');
});

test('stripJsonComments: line comment with no trailing newline', () => {
  assert.equal(stripJsonComments('{"a": 1} // EOF'), '{"a": 1} ');
});

test('stripJsonComments: unterminated block comment consumes remainder', () => {
  // Conservative: eat to EOF. JSON.parse then fails with a clearer error
  // about the missing `}` rather than a misleading comment message.
  assert.equal(stripJsonComments('{"a": 1 /* never closed'), '{"a": 1 ');
});

test('stripJsonComments: adjacent comments', () => {
  // Input has a single space between the second `*/` and `"x"`; both
  // block comments collapse to empty, leaving just that one space.
  assert.equal(stripJsonComments('/* a *//* b */ "x"'), ' "x"');
});

// ──────────────────────────────────────────────────────────────────────
// parseJsonc (end-to-end)
// ──────────────────────────────────────────────────────────────────────

test('parseJsonc: returns the same object as JSON.parse on pure JSON', () => {
  const src = '{"allow": ["git log*", "npm test"], "deny": ["rm -rf*"]}';
  assert.deepEqual(parseJsonc(src), JSON.parse(src));
});

test('parseJsonc: realistic rule file with commentary', () => {
  const src = `{
    // Allow rules
    "allow": [
      "git log*",         // safe history inspection
      "git diff*",        /* safe diff inspection */
      "npm test"          // exact: no args
    ],
    /* Hard-deny a few things the hardcoded list misses */
    "deny": [
      "sudo*",
      "rm -rf node_modules"
    ]
  }`;
  const parsed = parseJsonc<{ allow: string[]; deny: string[] }>(src);
  assert.deepEqual(parsed.allow, ['git log*', 'git diff*', 'npm test']);
  assert.deepEqual(parsed.deny, ['sudo*', 'rm -rf node_modules']);
});

test('parseJsonc: propagates SyntaxError from malformed JSON', () => {
  // Trailing commas are NOT supported — verify they still throw, so a
  // future decision to allow them is a deliberate opt-in.
  assert.throws(() => parseJsonc('{"a": 1,}'), SyntaxError);
  // Genuinely broken input also throws.
  assert.throws(() => parseJsonc('{"a": }'), SyntaxError);
});

test('parseJsonc: parse-error line numbers line up with original source', () => {
  // The value on line 4 is invalid JSON (`nope`). With newline-preserving
  // comment stripping, the SyntaxError's reported position should still
  // reference the original line.
  const src = ['{', '  // header', '  /* a block', '     comment */', '  "a": nope', '}'].join('\n');
  let caught: unknown;
  try {
    parseJsonc(src);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof SyntaxError);
  const stripped = stripJsonComments(src);
  // The stripped output has the same number of lines as the original.
  assert.equal(stripped.split('\n').length, src.split('\n').length);
  // And the offending `nope` token is still on the same line index.
  const origLine = src.split('\n').findIndex((l) => l.includes('nope'));
  const strippedLine = stripped.split('\n').findIndex((l) => l.includes('nope'));
  assert.equal(strippedLine, origLine);
});
