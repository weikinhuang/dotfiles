/**
 * Tests for lib/node/pi/jsonc.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  clearConfigWarning,
  type ConfigWarning,
  loadJsoncConfigOrFallback,
  parseJsonc,
  stripJsonComments,
  tryReadJsoncFile,
} from '../../../../lib/node/pi/jsonc.ts';

// ──────────────────────────────────────────────────────────────────────
// stripJsonComments
// ──────────────────────────────────────────────────────────────────────

test('stripJsonComments: pure JSON passes through unchanged', () => {
  const src = '{"a": 1, "b": [2, 3]}';

  expect(stripJsonComments(src)).toBe(src);
});

test('stripJsonComments: drops // line comments', () => {
  expect(stripJsonComments('{\n  "a": 1 // a trailing comment\n}')).toBe('{\n  "a": 1 \n}');
  expect(stripJsonComments('// header line\n{"a": 1}')).toBe('\n{"a": 1}');
});

test('stripJsonComments: drops /* */ block comments', () => {
  expect(stripJsonComments('{"a": /* inline */ 1}')).toBe('{"a":  1}');
});

test('stripJsonComments: block comments preserve embedded newlines', () => {
  // Critical for parse-error line numbers to still point at the right
  // line of the original source after stripping.
  const src = '{\n  /* this\n     spans\n     lines */\n  "a": 1\n}';
  const out = stripJsonComments(src);
  // Three embedded newlines inside the block comment must survive.
  const originalNewlines = (src.match(/\n/g) ?? []).length;
  const strippedNewlines = (out.match(/\n/g) ?? []).length;

  expect(strippedNewlines).toBe(originalNewlines);
});

test('stripJsonComments: // and /* inside strings are NOT stripped', () => {
  // The canonical footgun: URLs inside JSON strings.
  expect(stripJsonComments('{"url": "https://example.com/path"}')).toBe('{"url": "https://example.com/path"}');
  // Block-comment-looking substrings inside strings.
  expect(stripJsonComments('{"pattern": "/* not a comment */"}')).toBe('{"pattern": "/* not a comment */"}');
  // Adjacent to a real comment.
  expect(stripJsonComments('{"url": "https://ex.com"} // real comment')).toBe('{"url": "https://ex.com"} ');
});

test('stripJsonComments: escaped quotes do not end strings early', () => {
  // `"a\"b // not a comment"` - the escaped quote keeps us inside the string.
  const src = '{"s": "a\\"b // still inside"}';

  expect(stripJsonComments(src)).toBe(src);
});

test('stripJsonComments: backslash-quote pairs inside a string', () => {
  // `{"s": "\\"}` - a single backslash then end-of-string. Must round-trip.
  const src = '{"s": "\\\\"}';

  expect(stripJsonComments(src)).toBe(src);
  // And the parsed value is the single-char backslash.
  expect(parseJsonc<{ s: string }>(src).s).toBe('\\');
});

test('stripJsonComments: line comment with no trailing newline', () => {
  expect(stripJsonComments('{"a": 1} // EOF')).toBe('{"a": 1} ');
});

test('stripJsonComments: unterminated block comment consumes remainder', () => {
  // Conservative: eat to EOF. JSON.parse then fails with a clearer error
  // about the missing `}` rather than a misleading comment message.
  expect(stripJsonComments('{"a": 1 /* never closed')).toBe('{"a": 1 ');
});

test('stripJsonComments: adjacent comments', () => {
  // Input has a single space between the second `*/` and `"x"`; both
  // block comments collapse to empty, leaving just that one space.
  expect(stripJsonComments('/* a *//* b */ "x"')).toBe(' "x"');
});

// ──────────────────────────────────────────────────────────────────────
// parseJsonc (end-to-end)
// ──────────────────────────────────────────────────────────────────────

test('parseJsonc: returns the same object as JSON.parse on pure JSON', () => {
  const src = '{"allow": ["git log*", "npm test"], "deny": ["rm -rf*"]}';

  expect(parseJsonc(src)).toEqual(JSON.parse(src));
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

  expect(parsed.allow).toEqual(['git log*', 'git diff*', 'npm test']);
  expect(parsed.deny).toEqual(['sudo*', 'rm -rf node_modules']);
});

test('parseJsonc: propagates SyntaxError from malformed JSON', () => {
  // Trailing commas are NOT supported - verify they still throw, so a
  // future decision to allow them is a deliberate opt-in.
  expect(() => parseJsonc('{"a": 1,}')).toThrow(SyntaxError);
  // Genuinely broken input also throws.
  expect(() => parseJsonc('{"a": }')).toThrow(SyntaxError);
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

  expect(caught).toBeInstanceOf(SyntaxError);

  const stripped = stripJsonComments(src);

  // The stripped output has the same number of lines as the original.
  expect(stripped.split('\n').length).toBe(src.split('\n').length);

  // And the offending `nope` token is still on the same line index.
  const origLine = src.split('\n').findIndex((l) => l.includes('nope'));
  const strippedLine = stripped.split('\n').findIndex((l) => l.includes('nope'));

  expect(strippedLine).toBe(origLine);
});

// ──────────────────────────────────────────────────────────────────────
// loadJsoncConfigOrFallback / tryReadJsoncFile
// ──────────────────────────────────────────────────────────────────────

describe('loadJsoncConfigOrFallback / tryReadJsoncFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jsonc-config-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('loadJsoncConfigOrFallback: returns parsed value on success', () => {
    const p = join(tmp, 'ok.json');
    writeFileSync(p, '{"a": 1}');

    expect(loadJsoncConfigOrFallback('test-tag', p, () => ({}))).toEqual({ a: 1 });
  });

  test('loadJsoncConfigOrFallback: tolerates // comments', () => {
    const p = join(tmp, 'jsonc.json');
    writeFileSync(p, '// header\n{"a": 1}');

    expect(loadJsoncConfigOrFallback('test-tag', p, () => ({}))).toEqual({ a: 1 });
  });

  test('loadJsoncConfigOrFallback: returns fallback when file is missing', () => {
    const fallback = { a: 99 };
    const out = loadJsoncConfigOrFallback('test-tag', join(tmp, 'nope.json'), () => fallback);

    expect(out).toBe(fallback);
  });

  test('loadJsoncConfigOrFallback: returns fallback on parse error', () => {
    const p = join(tmp, 'bad.json');
    writeFileSync(p, '{ not: json');

    // clearConfigWarning between tests so the dedup state doesn't bleed.
    clearConfigWarning('test-tag', p);

    expect(loadJsoncConfigOrFallback('test-tag', p, () => ({ fallback: true }))).toEqual({ fallback: true });
  });

  test('tryReadJsoncFile: missing file returns undefined and pushes no warning', () => {
    const warnings: ConfigWarning[] = [];
    const out = tryReadJsoncFile(join(tmp, 'nope.json'), warnings);

    expect(out).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test('tryReadJsoncFile: parse error pushes one warning and returns undefined', () => {
    const warnings: ConfigWarning[] = [];
    const p = join(tmp, 'bad.json');
    writeFileSync(p, '{ definitely not json');

    const out = tryReadJsoncFile(p, warnings);

    expect(out).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe(p);
  });

  test('tryReadJsoncFile: requireObject rejects non-object roots', () => {
    const warnings: ConfigWarning[] = [];
    const p = join(tmp, 'array.json');
    writeFileSync(p, '[1, 2, 3]');

    const out = tryReadJsoncFile(p, warnings, { requireObject: true });

    expect(out).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.error).toMatch(/must be an object/);
  });

  test('tryReadJsoncFile: accepts arrays without requireObject', () => {
    const warnings: ConfigWarning[] = [];
    const p = join(tmp, 'array.json');
    writeFileSync(p, '[1, 2, 3]');

    expect(tryReadJsoncFile(p, warnings)).toEqual([1, 2, 3]);
    expect(warnings).toEqual([]);
  });
});
