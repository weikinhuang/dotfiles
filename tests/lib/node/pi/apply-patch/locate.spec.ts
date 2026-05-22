/**
 * Tests for lib/node/pi/apply-patch/locate.ts. Pure module.
 *
 * Some fixtures intentionally mirror tests/lib/node/pi/edit-recovery.spec.ts
 * so the two locators agree on the same files.
 */

import { describe, expect, test } from 'vitest';

import { hunkNewLines, hunkOldLines, locateHunk } from '../../../../../lib/node/pi/apply-patch/locate.ts';
import type { Hunk, HunkLine, HunkLineKind } from '../../../../../lib/node/pi/apply-patch/parse.ts';

function hunk(...specs: string[]): Hunk {
  const lines: HunkLine[] = specs.map((spec) => {
    const kind = spec[0] as HunkLineKind | undefined;
    if (kind !== ' ' && kind !== '-' && kind !== '+') throw new Error(`bad spec ${spec}`);
    return { kind, text: spec.slice(1) };
  });
  return { lines };
}

const FILE = [
  'export function greet() {',
  '    console.log("hi");',
  '}',
  '',
  'export function shout() {',
  '    console.log("HEY");',
  '}',
  '',
];

// ──────────────────────────────────────────────────────────────────────
// hunkOldLines / hunkNewLines
// ──────────────────────────────────────────────────────────────────────

describe('hunkOldLines / hunkNewLines', () => {
  test('old = context + removed; new = context + added', () => {
    const h = hunk(' keep', '-drop', '+add', ' tail');
    expect(hunkOldLines(h)).toEqual(['keep', 'drop', 'tail']);
    expect(hunkNewLines(h)).toEqual(['keep', 'add', 'tail']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Exact match
// ──────────────────────────────────────────────────────────────────────

describe('locateHunk: exact match', () => {
  test('finds the unique region', () => {
    const h = hunk(' export function greet() {', '-    console.log("hi");', '+    console.log("HI");', ' }');
    expect(locateHunk(FILE, h)).toEqual({ kind: 'found', line: 1, span: 3 });
  });

  test('single-line hunk against single matching line', () => {
    const h = hunk(' export function shout() {', '-    console.log("HEY");', '+    console.log("hey");', ' }');
    expect(locateHunk(FILE, h)).toEqual({ kind: 'found', line: 5, span: 3 });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Whitespace-insensitive fallback
// ──────────────────────────────────────────────────────────────────────

describe('locateHunk: whitespace-insensitive fallback', () => {
  test('mixed tab/space indentation still locates the region', () => {
    // Hunk uses tab indentation; file uses 4-space indentation. Exact
    // match fails; the normalize step makes them equal.
    const h = hunk(' export function greet() {', '-\tconsole.log("hi");', '+\tconsole.log("HI");', ' }');
    const out = locateHunk(FILE, h);
    if (out.kind !== 'found') throw new Error(`expected found, got ${out.kind}`);
    expect(out.line).toBe(1);
    expect(out.span).toBe(3);
  });

  test('collapsed-whitespace hunk still locates', () => {
    const h = hunk(' export function greet() {', '- console.log("hi");', '+ console.log("HI");', ' }');
    const out = locateHunk(FILE, h);
    if (out.kind !== 'found') throw new Error(`expected found, got ${out.kind}`);
    expect(out.line).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Ambiguous
// ──────────────────────────────────────────────────────────────────────

describe('locateHunk: ambiguous', () => {
  test('two equally-good regions', () => {
    // Both function bodies end with `}` then `''` — the hunk old-side
    // of just `}` matches both.
    const h = hunk(' }', '-', '+// done');
    const out = locateHunk(FILE, h);
    if (out.kind !== 'ambiguous') throw new Error(`expected ambiguous, got ${out.kind}`);
    expect(out.candidates.length).toBeGreaterThanOrEqual(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// No match
// ──────────────────────────────────────────────────────────────────────

describe('locateHunk: no-match', () => {
  test('hunk text absent from the file', () => {
    const h = hunk(' nothing like this exists', '-anywhere', '+at all');
    expect(locateHunk(FILE, h).kind).toBe('no-match');
  });

  test('empty old-side (pure insertion) is rejected as no-match', () => {
    const h = hunk('+only an added line');
    expect(locateHunk(FILE, h).kind).toBe('no-match');
  });
});

// ──────────────────────────────────────────────────────────────────────
// searchFrom
// ──────────────────────────────────────────────────────────────────────

describe('locateHunk: searchFrom', () => {
  test('confines later searches to a forward window', () => {
    // `}` appears at lines 3 and 7. searchFrom=4 should drop line 3
    // and leave line 7 as the unique match.
    const h = hunk(' }');
    const out = locateHunk(FILE, h, { searchFrom: 4 });
    if (out.kind !== 'found') throw new Error(`expected found, got ${out.kind}`);
    expect(out.line).toBe(7);
  });
});
