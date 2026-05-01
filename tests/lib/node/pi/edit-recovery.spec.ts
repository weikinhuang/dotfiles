/**
 * Tests for lib/node/pi/edit-recovery.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';
import {
  findAnchorCandidates,
  findCandidates,
  formatSnippet,
  locateAndFormat,
  normalizeAggressiveFlat,
  normalizeAggressiveLines,
  parseEditFailure,
} from '../../../../lib/node/pi/edit-recovery.ts';

// ──────────────────────────────────────────────────────────────────────
// parseEditFailure
// ──────────────────────────────────────────────────────────────────────

describe('parseEditFailure', () => {
  test('single-edit not-found', () => {
    const out = parseEditFailure(
      'Could not find the exact text in /tmp/x.ts. The old text must match exactly including all whitespace and newlines.',
    );

    expect(out).toEqual({ kind: 'not-found', editIndex: 0, path: '/tmp/x.ts' });
  });

  test('multi-edit not-found', () => {
    const out = parseEditFailure(
      'Could not find edits[2] in /tmp/x.ts. The oldText must match exactly including all whitespace and newlines.',
    );

    expect(out).toEqual({ kind: 'not-found', editIndex: 2, path: '/tmp/x.ts' });
  });

  test('single-edit duplicate', () => {
    const out = parseEditFailure(
      'Found 3 occurrences of the text in src/foo.ts. The text must be unique. Please provide more context to make it unique.',
    );

    expect(out).toEqual({ kind: 'duplicate', editIndex: 0, path: 'src/foo.ts', occurrences: 3 });
  });

  test('multi-edit duplicate', () => {
    const out = parseEditFailure(
      'Found 2 occurrences of edits[1] in src/foo.ts. Each oldText must be unique. Please provide more context to make it unique.',
    );

    expect(out).toEqual({ kind: 'duplicate', editIndex: 1, path: 'src/foo.ts', occurrences: 2 });
  });

  test('ignores empty blank lines around the canonical message', () => {
    const out = parseEditFailure(
      '\n\n   Could not find the exact text in /tmp/x.ts. The old text must match exactly including all whitespace and newlines.\n   \n',
    );

    expect(out?.kind).toBe('not-found');
  });

  test('returns undefined for unrecognized text', () => {
    expect(parseEditFailure('some other error')).toBeUndefined();
    expect(parseEditFailure('')).toBeUndefined();
    expect(parseEditFailure(undefined as unknown as string)).toBeUndefined();
  });

  test('handles path with colons and slashes', () => {
    const out = parseEditFailure(
      'Could not find the exact text in C:/Users/me/file.ts. The old text must match exactly including all whitespace and newlines.',
    );

    expect(out?.path).toBe('C:/Users/me/file.ts');
  });
});

// ──────────────────────────────────────────────────────────────────────
// normalizeAggressiveLines / normalizeAggressiveFlat
// ──────────────────────────────────────────────────────────────────────

describe('normalizeAggressiveLines', () => {
  test('strips leading whitespace and collapses runs', () => {
    expect(normalizeAggressiveLines('    console.log("hi");')).toEqual(['console.log("hi");']);
  });

  test('tabs and spaces normalize to the same output', () => {
    expect(normalizeAggressiveLines('\t\tfoo();')).toEqual(normalizeAggressiveLines('        foo();'));
  });

  test('smart quotes normalize to ascii', () => {
    // Uses NFKC + smart quote replacement from the pi-matching pass.
    expect(normalizeAggressiveLines('\u201chello\u201d')).toEqual(['"hello"']);
  });

  test('internal runs collapse but tokens preserved', () => {
    expect(normalizeAggressiveLines('const  x  =  42;')).toEqual(['const x = 42;']);
  });

  test('preserves blank lines (empty strings)', () => {
    expect(normalizeAggressiveLines('a\n\nb')).toEqual(['a', '', 'b']);
  });
});

describe('normalizeAggressiveFlat', () => {
  test('collapses everything to a single trimmed line', () => {
    expect(normalizeAggressiveFlat('  foo  \n\n  bar  ')).toBe('foo bar');
  });
});

// ──────────────────────────────────────────────────────────────────────
// findCandidates
// ──────────────────────────────────────────────────────────────────────

describe('findCandidates', () => {
  const file = [
    'export function greet() {',
    '  console.log("hi");',
    '}',
    '',
    'export function shout() {',
    '  console.log("HEY");',
    '}',
  ];
  const normFile = file.map((l) => l.replace(/^\s+/, '').replace(/\s+/g, ' '));

  test('single multi-line match', () => {
    const old = ['console.log("hi");'];

    expect(findCandidates(normFile, old)).toEqual([{ startLine: 2, endLine: 2 }]);
  });

  test('two candidate ranges', () => {
    const old = ['}']; // literal close-brace lines — appears twice

    expect(findCandidates(normFile, old)).toEqual([
      { startLine: 3, endLine: 3 },
      { startLine: 7, endLine: 7 },
    ]);
  });

  test('returns empty for empty oldText', () => {
    expect(findCandidates(normFile, [])).toEqual([]);
  });

  test('multi-line match uses endLine=startLine+len-1', () => {
    const old = ['export function greet() {', 'console.log("hi");', '}'];

    expect(findCandidates(normFile, old)).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  test('returns empty when file is shorter than oldText', () => {
    expect(findCandidates(['a'], ['a', 'b'])).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// findAnchorCandidates
// ──────────────────────────────────────────────────────────────────────

describe('findAnchorCandidates', () => {
  test('returns positions of the first non-empty oldText line', () => {
    const file = ['a', 'b', 'a', 'c', 'a'];
    const old = ['a', 'b'];

    expect(findAnchorCandidates(file, old)).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 3 },
      { startLine: 5, endLine: 5 },
    ]);
  });

  test('respects max cap', () => {
    const file = ['x', 'x', 'x', 'x', 'x', 'x'];
    const old = ['x'];

    expect(findAnchorCandidates(file, old, 2)).toHaveLength(2);
  });

  test('skips leading blank lines in oldText for the anchor', () => {
    const file = ['x', 'foo', 'y'];
    const old = ['', 'foo'];

    expect(findAnchorCandidates(file, old)).toEqual([{ startLine: 2, endLine: 2 }]);
  });

  test('returns empty when oldText is all-empty', () => {
    expect(findAnchorCandidates(['a'], ['', ''])).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatSnippet
// ──────────────────────────────────────────────────────────────────────

describe('formatSnippet', () => {
  const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  test('marks the target region with >> and shows line numbers', () => {
    const out = formatSnippet(lines, { startLine: 3, endLine: 4 }, { contextLines: 1 });

    // Expect lines 2..5 with >> on 3-4
    expect(out).toContain('   2 │ b');
    expect(out).toContain('>> 3 │ c');
    expect(out).toContain('>> 4 │ d');
    expect(out).toContain('   5 │ e');
    // line 1 and 6 should be absent (context=1)
    expect(out).not.toContain('│ a');
    expect(out).not.toContain('│ f');
  });

  test('clamps contextLines at file start/end', () => {
    const out = formatSnippet(lines, { startLine: 1, endLine: 1 }, { contextLines: 3 });

    expect(out).toContain('>> 1 │ a');
    expect(out).toContain('   4 │ d');
    // Should not go beyond file bounds
    expect(out).not.toContain('line 0');
  });

  test('truncates very large snippets', () => {
    const big = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
    const out = formatSnippet(big, { startLine: 50, endLine: 51 }, { contextLines: 5, maxLines: 5 });

    expect(out).toContain('snippet truncated at 5 lines');
    expect(out.split('\n').length).toBeLessThanOrEqual(6); // 5 + truncation line
  });
});

// ──────────────────────────────────────────────────────────────────────
// locateAndFormat (end-to-end)
// ──────────────────────────────────────────────────────────────────────

const FILE = [
  'export function greet() {',
  '    console.log("hi");', // 4-space indent
  '}',
  '',
  'export function shout() {',
  '    console.log("HEY");',
  '}',
  '',
].join('\n');

describe('locateAndFormat: exact-1 (whitespace-only mismatch)', () => {
  test('finds the intended line and renders a marked snippet', () => {
    const out = locateAndFormat({
      errorText:
        'Could not find the exact text in /tmp/x.ts. The old text must match exactly including all whitespace and newlines.',
      edits: [{ oldText: '\tconsole.log("hi");', newText: '\tconsole.log("HI");' }],
      fileContent: FILE,
      pathForDisplay: '/tmp/x.ts',
    });

    expect(out.kind).toBe('exact-1');
    expect(out.text).toContain('line 2');
    expect(out.text).toContain('>> 2 │     console.log("hi");');
    expect(out.text).toMatch(/Retry with `oldText` copied verbatim/);
  });

  test('single-line anchor resolves multi-line oldText', () => {
    const out = locateAndFormat({
      errorText:
        'Could not find the exact text in x.ts. The old text must match exactly including all whitespace and newlines.',
      edits: [
        {
          oldText: 'export function greet() {\n\tconsole.log("hi");\n}',
          newText: 'export function greet() { /* x */ }',
        },
      ],
      fileContent: FILE,
      pathForDisplay: 'x.ts',
    });

    expect(out.kind).toBe('exact-1');
    expect(out.candidates).toEqual([{ startLine: 1, endLine: 3 }]);
  });
});

describe('locateAndFormat: exact-many', () => {
  test('reports every candidate region and tells the model to pick one', () => {
    const out = locateAndFormat({
      errorText:
        'Found 2 occurrences of the text in x.ts. The text must be unique. Please provide more context to make it unique.',
      edits: [{ oldText: '}', newText: '/* done */ }' }],
      fileContent: FILE,
      pathForDisplay: 'x.ts',
    });

    expect(out.kind).toBe('exact-many');
    expect(out.candidates).toHaveLength(2);
    expect(out.text).toContain('2 exact matches');
    expect(out.text).toContain('extending `oldText`');

    // Should include both snippet blocks
    expect(out.text?.match(/```/g)).toHaveLength(4); // 2 opens, 2 closes
  });
});

describe('locateAndFormat: anchor fallback', () => {
  test('returns candidate anchors when multi-line match fails', () => {
    const out = locateAndFormat({
      errorText:
        'Could not find the exact text in x.ts. The old text must match exactly including all whitespace and newlines.',
      edits: [{ oldText: 'export function greet() {\n  // body that does not exist\n}', newText: '...' }],
      fileContent: FILE,
      pathForDisplay: 'x.ts',
    });

    expect(out.kind).toBe('anchor');
    expect(out.text).toContain('Near line 1');
    expect(out.text).toMatch(/first line of your oldText does appear/);
  });
});

describe('locateAndFormat: no-match', () => {
  test('returns a concise "use read/grep" message when nothing fuzzy-matches', () => {
    const out = locateAndFormat({
      errorText:
        'Could not find the exact text in x.ts. The old text must match exactly including all whitespace and newlines.',
      edits: [{ oldText: 'nothing like this exists anywhere', newText: '' }],
      fileContent: FILE,
      pathForDisplay: 'x.ts',
    });

    expect(out.kind).toBe('no-match');
    expect(out.text).toMatch(/may not exist in the file/);
  });
});

describe('locateAndFormat: unreadable', () => {
  test('returns a short notice when file content is missing', () => {
    const out = locateAndFormat({
      errorText:
        'Could not find the exact text in /does/not/exist.ts. The old text must match exactly including all whitespace and newlines.',
      edits: [{ oldText: 'x', newText: 'y' }],
      fileContent: undefined,
      pathForDisplay: '/does/not/exist.ts',
    });

    expect(out.kind).toBe('unreadable');
    expect(out.text).toMatch(/Use `read` on the file yourself/);
  });
});

describe('locateAndFormat: not recognized → undefined', () => {
  test('unrecognized error returns no text', () => {
    const out = locateAndFormat({
      errorText: 'some completely unrelated error',
      edits: [{ oldText: 'x', newText: 'y' }],
      fileContent: FILE,
      pathForDisplay: 'x.ts',
    });

    expect(out.text).toBeUndefined();
  });

  test('missing edits[N] for the reported index returns no text', () => {
    const out = locateAndFormat({
      errorText:
        'Could not find edits[5] in x.ts. The oldText must match exactly including all whitespace and newlines.',
      edits: [{ oldText: 'x', newText: 'y' }], // only one edit
      fileContent: FILE,
      pathForDisplay: 'x.ts',
    });

    expect(out.text).toBeUndefined();
  });
});

describe('locateAndFormat: duplicate case with only one match (rare)', () => {
  // Pi reports the error when the EXACT match had duplicates. Our
  // aggressive normalize might collapse them to a single candidate, in
  // which case the single-match path is the right output.
  test('collapses to single match if aggressive normalize disambiguates', () => {
    const file = 'console.log("x");\nCONSOLE.log("x");\n'; // case differs but whitespace-equal
    const out = locateAndFormat({
      errorText:
        'Found 1 occurrences of the text in x.ts. The text must be unique. Please provide more context to make it unique.',
      edits: [{ oldText: 'console.log("x");', newText: 'console.log("y");' }],
      fileContent: file,
      pathForDisplay: 'x.ts',
    });

    // Our normalize is case-sensitive — so only the first line should match.
    expect(out.kind).toBe('exact-1');
  });
});
