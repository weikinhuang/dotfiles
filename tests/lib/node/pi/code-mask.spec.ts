/**
 * Tests for lib/node/pi/code-mask.ts.
 */

import { describe, expect, test } from 'vitest';

import { type CodeSegment, isFenceLine, splitCodeSegments } from '../../../../lib/node/pi/code-mask.ts';

/** Reassemble segments; must always round-trip to the original text. */
function join(segs: CodeSegment[]): string {
  return segs.map((s) => s.text).join('');
}

/** The concatenated text of every run flagged `code: true`. */
function codeText(segs: CodeSegment[]): string {
  return segs
    .filter((s) => s.code)
    .map((s) => s.text)
    .join('');
}

describe('isFenceLine', () => {
  test('matches 3+ backticks / tildes at line start (with optional indent)', () => {
    expect(isFenceLine('```')).toBe(true);
    expect(isFenceLine('```ts')).toBe(true);
    expect(isFenceLine('~~~')).toBe(true);
    expect(isFenceLine('   ```')).toBe(true);
    expect(isFenceLine('`````')).toBe(true);
  });

  test('does not match inline / mid-line backticks or short runs', () => {
    expect(isFenceLine('use ``` literally')).toBe(false);
    expect(isFenceLine('`x`')).toBe(false);
    expect(isFenceLine('``')).toBe(false);
    expect(isFenceLine('plain prose')).toBe(false);
  });
});

describe('splitCodeSegments: round-trip + fast path', () => {
  test('always round-trips to the original text', () => {
    for (const src of [
      'plain prose',
      'a `code` b',
      'pre\n```\nblock\n```\npost',
      '`unterminated',
      '```\nopen fence only',
      '',
    ]) {
      expect(join(splitCodeSegments(src))).toBe(src);
    }
  });

  test('text with no backtick / tilde is a single prose run', () => {
    const segs = splitCodeSegments('plain [c:red] prose');
    expect(segs).toEqual([{ text: 'plain [c:red] prose', code: false }]);
  });
});

describe('splitCodeSegments: inline code spans', () => {
  test('a single-backtick span is one code run; surrounding text is prose', () => {
    const segs = splitCodeSegments('before `[c:red]x` after');
    expect(codeText(segs)).toBe('`[c:red]x`');
    expect(segs[0]).toEqual({ text: 'before ', code: false });
    expect(segs[segs.length - 1]).toEqual({ text: ' after', code: false });
  });

  test('multi-backtick span is code (run parity)', () => {
    const segs = splitCodeSegments('see ``[c:red]`` here');
    expect(codeText(segs)).toBe('``[c:red]``');
  });

  test('two separate spans: the text between them is prose', () => {
    const segs = splitCodeSegments('`a` mid [c:red] `b`');
    const prose = segs
      .filter((s) => !s.code)
      .map((s) => s.text)
      .join('');
    expect(prose).toBe(' mid [c:red] ');
  });

  test('an unterminated opener makes the rest of the line code', () => {
    const segs = splitCodeSegments('open `[c:red] never closed');
    expect(codeText(segs)).toBe('`[c:red] never closed');
  });

  test('inline state resets per line (a backtick on a prior line does not leak)', () => {
    const segs = splitCodeSegments('prior `code`\n[c:red] on next line');
    expect(codeText(segs)).toBe('`code`');
    // The [c:red] on the next line is prose.
    expect(join(segs).endsWith('[c:red] on next line')).toBe(true);
    expect(segs.some((s) => !s.code && s.text.includes('[c:red] on next line'))).toBe(true);
  });
});

describe('splitCodeSegments: fenced blocks', () => {
  test('fence body + delimiters are code; surrounding prose is not', () => {
    const segs = splitCodeSegments('before\n```\n[c:red] inside\n```\nafter');
    expect(codeText(segs)).toBe('```\n[c:red] inside\n```');
    expect(segs[0]).toEqual({ text: 'before\n', code: false });
    expect(segs[segs.length - 1]).toEqual({ text: '\nafter', code: false });
  });

  test('an opening fence with an info string is code on the delimiter line', () => {
    const segs = splitCodeSegments('```ts\n[c:red]\n```');
    expect(codeText(segs)).toBe('```ts\n[c:red]\n```');
  });

  test('tilde fences work too', () => {
    const segs = splitCodeSegments('~~~\n[c:red] x\n~~~');
    expect(codeText(segs)).toBe('~~~\n[c:red] x\n~~~');
  });

  test('an unterminated fence makes everything after the opener code', () => {
    const segs = splitCodeSegments('intro\n```\n[c:red] still open');
    expect(codeText(segs)).toBe('```\n[c:red] still open');
  });
});
