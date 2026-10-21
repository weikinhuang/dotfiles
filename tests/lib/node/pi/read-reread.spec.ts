/**
 * Tests for lib/node/pi/read-reread.ts - pure module, no pi runtime.
 */

import { describe, expect, test } from 'vitest';

import {
  describeLines,
  formatNudge,
  isNudgeDecision,
  NUDGE_MARKER,
  ReadHistory,
  type ReadTruncationLike,
  type RereadDecision,
  type RereadProbe,
  resolveReadRange,
} from '../../../../lib/node/pi/read-reread.ts';
import { assertKind } from './helpers.ts';

function probe(
  path: string,
  mtimeMs: number,
  size: number,
  opts: { offset?: number; limit?: number; turn?: number; range?: { start: number; end: number } } = {},
): RereadProbe {
  return {
    sig: { path, mtimeMs, size },
    offset: opts.offset,
    limit: opts.limit,
    turn: opts.turn ?? 1,
    range: opts.range,
  };
}

/** Classify then record, like the extension does; returns the decision. */
function read(h: ReadHistory, p: RereadProbe): RereadDecision {
  const decision = h.classify(p);
  h.record(p);
  return decision;
}

/** Text body of `n` numbered lines starting at `start`. */
function lines(start: number, n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${start + i}`).join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// ReadHistory.classify
// ──────────────────────────────────────────────────────────────────────

describe('ReadHistory.classify', () => {
  test('returns first-time when path is unseen', () => {
    const h = new ReadHistory();

    expect(h.classify(probe('/a', 100, 50)).kind).toBe('first-time');
  });

  test('same path + same signature + same slice → same-slice', () => {
    const h = new ReadHistory();
    h.record(probe('/a', 100, 50));

    expect(h.classify(probe('/a', 100, 50)).kind).toBe('same-slice');
  });

  test('next window at previous end + 1 → continuation (no nudge)', () => {
    const h = new ReadHistory();
    h.record(probe('/a', 100, 50, { offset: 1, limit: 100 }));

    const out = h.classify(probe('/a', 100, 50, { offset: 101, limit: 100 }));

    expect(out.kind).toBe('continuation');
    expect(isNudgeDecision(out)).toBe(false);
  });

  test('same offset, doubled limit (50% already covered) → overlap', () => {
    const h = new ReadHistory();
    h.record(probe('/a', 100, 50, { offset: 1, limit: 100 }));

    const out = h.classify(probe('/a', 100, 50, { offset: 1, limit: 200 }));

    assertKind(out, 'overlap');

    expect(out.overlap).toStrictEqual([{ start: 1, end: 100 }]);
    expect(out.ratio).toBe(0.5);
  });

  test('treats undefined offset as equivalent to offset=1 (first line)', () => {
    const h = new ReadHistory();
    h.record(probe('/a', 100, 50, { offset: undefined, limit: 10 }));

    expect(h.classify(probe('/a', 100, 50, { offset: 1, limit: 10 })).kind).toBe('same-slice');
  });

  test('mtime change → changed', () => {
    const h = new ReadHistory();
    h.record(probe('/a', 100, 50));

    expect(h.classify(probe('/a', 200, 50)).kind).toBe('changed');
  });

  test('size change → changed', () => {
    const h = new ReadHistory();
    h.record(probe('/a', 100, 50));

    expect(h.classify(probe('/a', 100, 51)).kind).toBe('changed');
  });

  test('classify does not mutate state', () => {
    const h = new ReadHistory();
    h.record(probe('/a', 100, 50));
    h.classify(probe('/a', 100, 50));
    h.classify(probe('/b', 1, 1));

    expect(h.size()).toBe(1);
    expect(h.get('/a')?.intervals).toHaveLength(1);
  });

  test('exposes the previous record on non-first-time outcomes', () => {
    const h = new ReadHistory();

    h.record(probe('/a', 100, 50, { offset: 10, limit: 20, turn: 3 }));

    const out = h.classify(probe('/a', 100, 50, { offset: 10, limit: 20, turn: 9 }));

    assertKind(out, 'same-slice');

    expect(out.previous.turn).toBe(3);
    expect(out.previous.offset).toBe(10);
    expect(out.overlapTurn).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Paging vs re-reading (plan 03 acceptance)
// ──────────────────────────────────────────────────────────────────────

describe('ReadHistory paging vs re-reads', () => {
  test('paging a 900-line file in three reads via continuation offsets never nudges', () => {
    const h = new ReadHistory();
    const sig = ['/big.md', 7, 90_000] as const;
    const trunc = (outputLines: number): ReadTruncationLike => ({
      truncated: true,
      outputLines,
      firstLineExceedsLimit: false,
    });

    // Each range is resolved from the read result the way the extension does it.
    const r1 = resolveReadRange({ offset: undefined, limit: undefined, text: lines(1, 300), truncation: trunc(300) });
    const r2 = resolveReadRange({ offset: 301, limit: undefined, text: lines(301, 300), truncation: trunc(300) });
    const r3 = resolveReadRange({ offset: 601, limit: undefined, text: lines(601, 299) });

    const kinds = [
      read(h, probe(...sig, { range: r1 })),
      read(h, probe(...sig, { offset: 301, range: r2 })),
      read(h, probe(...sig, { offset: 601, range: r3 })),
    ].map((d) => d.kind);

    expect(kinds).toStrictEqual(['first-time', 'continuation', 'continuation']);
    expect(h.get('/big.md')?.intervals).toStrictEqual([expect.objectContaining({ start: 1, end: 899 })]);
  });

  test('byte-truncated open-ended read then the footer offset → continuation', () => {
    const h = new ReadHistory();
    const first = `${lines(1, 604)}\n\n[Showing lines 1-604 of 899 (50.0KB limit). Use offset=605 to continue.]`;
    const r1 = resolveReadRange({ offset: undefined, limit: undefined, text: first });
    const r2 = resolveReadRange({ offset: 605, limit: undefined, text: lines(605, 295) });

    expect(r1).toStrictEqual({ start: 1, end: 604 });
    expect(read(h, probe('/rp.md', 1, 2, { range: r1 })).kind).toBe('first-time');
    expect(read(h, probe('/rp.md', 1, 2, { offset: 605, range: r2 })).kind).toBe('continuation');
  });

  test('two disjoint offset/limit windows never nudge', () => {
    const h = new ReadHistory();

    expect(read(h, probe('/rp.ts', 1, 2, { offset: 400, limit: 560 })).kind).toBe('first-time');
    expect(read(h, probe('/rp.ts', 1, 2, { offset: 1770, limit: 300 })).kind).toBe('disjoint');

    const h2 = new ReadHistory();
    read(h2, probe('/rr.ts', 1, 2, { offset: 8, limit: 40 }));

    expect(read(h2, probe('/rr.ts', 1, 2, { offset: 85, limit: 30 })).kind).toBe('disjoint');
  });

  test('continuation that runs into later coverage still never nudges', () => {
    const h = new ReadHistory();
    read(h, probe('/a', 1, 1, { offset: 1, limit: 100 }));
    read(h, probe('/a', 1, 1, { offset: 201, limit: 100 }));

    expect(h.classify(probe('/a', 1, 1, { offset: 101, limit: 200 })).kind).toBe('continuation');
  });

  test('substantial overlap with an earlier read of the unchanged file nudges with the overlapping lines', () => {
    const h = new ReadHistory();
    read(h, probe('/rp.ts', 1, 2, { offset: 400, limit: 560, turn: 1 }));
    read(h, probe('/rp.ts', 1, 2, { offset: 1770, limit: 300, turn: 1 }));

    const out = h.classify(probe('/rp.ts', 1, 2, { offset: 500, limit: 400, turn: 1 }));

    assertKind(out, 'overlap');

    expect(out.overlap).toStrictEqual([{ start: 500, end: 899 }]);
    expect(isNudgeDecision(out)).toBe(true);
  });

  test('overlap below the threshold stays silent (partial-overlap)', () => {
    const h = new ReadHistory();
    read(h, probe('/a', 1, 1, { offset: 1, limit: 100 }));

    const out = h.classify(probe('/a', 1, 1, { offset: 81, limit: 100 }));

    assertKind(out, 'partial-overlap');

    expect(out.ratio).toBeCloseTo(0.2);
    expect(isNudgeDecision(out)).toBe(false);
  });

  test('overlapThreshold option tunes the cutoff', () => {
    const h = new ReadHistory(256, { overlapThreshold: 0.2 });
    read(h, probe('/a', 1, 1, { offset: 1, limit: 100 }));

    expect(h.classify(probe('/a', 1, 1, { offset: 81, limit: 100 })).kind).toBe('overlap');
  });

  test('full re-read after paging the whole file nudges as overlap across all pages', () => {
    const h = new ReadHistory();
    read(h, probe('/a', 1, 1, { range: { start: 1, end: 604 } }));
    read(h, probe('/a', 1, 1, { offset: 605, range: { start: 605, end: 899 } }));

    const out = h.classify(probe('/a', 1, 1, { range: { start: 1, end: 604 } }));

    assertKind(out, 'overlap');

    expect(out.overlap).toStrictEqual([{ start: 1, end: 604 }]);
  });

  test('re-reading a sub-range fully inside earlier coverage nudges', () => {
    const h = new ReadHistory();
    read(h, probe('/a', 1, 1, { offset: 1, limit: 200 }));

    expect(h.classify(probe('/a', 1, 1, { offset: 50, limit: 10 })).kind).toBe('overlap');
  });

  test('small-model loop: 5 full re-reads of the same unchanged file all nudge', () => {
    const h = new ReadHistory();
    const kinds = [1, 1, 2, 3, 3].map((turn) => read(h, probe('/src/app.ts', 5, 500, { turn })).kind);

    expect(kinds).toStrictEqual(['first-time', 'same-slice', 'same-slice', 'same-slice', 'same-slice']);
  });

  test('small-model loop with resolved ranges: identical full reads stay same-slice', () => {
    const h = new ReadHistory();
    const range = resolveReadRange({ offset: undefined, limit: undefined, text: lines(1, 120) });
    const kinds = [1, 2, 3].map((turn) => read(h, probe('/a', 1, 1, { turn, range })).kind);

    expect(kinds).toStrictEqual(['first-time', 'same-slice', 'same-slice']);
  });

  test('a changed signature resets coverage', () => {
    const h = new ReadHistory();
    read(h, probe('/a', 1, 1, { offset: 1, limit: 100 }));

    expect(read(h, probe('/a', 2, 1, { offset: 500, limit: 10 })).kind).toBe('changed');
    expect(h.get('/a')?.intervals).toStrictEqual([expect.objectContaining({ start: 500, end: 509 })]);
    expect(h.classify(probe('/a', 2, 1, { offset: 1, limit: 100 })).kind).toBe('disjoint');
  });
});

// ──────────────────────────────────────────────────────────────────────
// ReadHistory.record / clear / eviction
// ──────────────────────────────────────────────────────────────────────

describe('ReadHistory record/clear/eviction', () => {
  test('record updates in place for the same path', () => {
    const h = new ReadHistory();
    h.record(probe('/a', 100, 50, { turn: 1 }));
    h.record(probe('/a', 200, 60, { turn: 5 }));
    const got = h.get('/a');

    expect(got?.turn).toBe(5);
    expect(got?.sig.mtimeMs).toBe(200);
    expect(h.size()).toBe(1);
  });

  test('merges overlapping and adjacent intervals, keeping the latest turn', () => {
    const h = new ReadHistory();
    h.record(probe('/a', 1, 1, { offset: 1, limit: 10, turn: 1 }));
    h.record(probe('/a', 1, 1, { offset: 30, limit: 10, turn: 2 }));
    h.record(probe('/a', 1, 1, { offset: 11, limit: 19, turn: 3 }));

    expect(h.get('/a')?.intervals).toStrictEqual([expect.objectContaining({ start: 1, end: 39, turn: 3 })]);
  });

  test('caps intervals per file by dropping the least-recently-read one', () => {
    const h = new ReadHistory(256, { maxIntervals: 2 });
    h.record(probe('/a', 1, 1, { offset: 1, limit: 10 }));
    h.record(probe('/a', 1, 1, { offset: 100, limit: 10 }));
    h.record(probe('/a', 1, 1, { offset: 200, limit: 10 }));

    expect(h.get('/a')?.intervals.map((iv) => iv.start)).toStrictEqual([100, 200]);
    expect(h.classify(probe('/a', 1, 1, { offset: 1, limit: 10 })).kind).toBe('disjoint');
  });

  test('clear removes everything', () => {
    const h = new ReadHistory();
    h.record(probe('/a', 1, 1));
    h.record(probe('/b', 1, 1));
    h.clear();

    expect(h.size()).toBe(0);
  });

  test('evicts oldest entries past maxEntries', () => {
    const h = new ReadHistory(2);
    h.record(probe('/a', 1, 1));
    h.record(probe('/b', 1, 1));
    h.record(probe('/c', 1, 1));

    expect(h.size()).toBe(2);
    expect(h.get('/a')).toBeUndefined();
    expect(h.get('/b')).toBeDefined();
    expect(h.get('/c')).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveReadRange
// ──────────────────────────────────────────────────────────────────────

describe('resolveReadRange', () => {
  test('uses truncation details for truncated open-ended reads', () => {
    const truncation = { truncated: true, outputLines: 604, firstLineExceedsLimit: false };

    expect(resolveReadRange({ offset: undefined, limit: undefined, text: 'x', truncation })).toStrictEqual({
      start: 1,
      end: 604,
    });
  });

  test('uses the "Use offset=N to continue" footer for limit-bounded reads', () => {
    const text = `${lines(400, 560)}\n\n[1300 more lines in file. Use offset=960 to continue.]`;

    expect(resolveReadRange({ offset: 400, limit: 560, text })).toStrictEqual({ start: 400, end: 959 });
  });

  test('counts returned lines when the read reached EOF without a footer', () => {
    expect(resolveReadRange({ offset: 601, limit: undefined, text: lines(601, 299) })).toStrictEqual({
      start: 601,
      end: 899,
    });
  });

  test('ignores footer-like text that is not at the end of the result', () => {
    const text = 'see [Showing lines 1-604 of 899. Use offset=605 to continue.]\nmore\ntext';

    expect(resolveReadRange({ offset: undefined, limit: undefined, text })).toStrictEqual({ start: 1, end: 3 });
  });

  test('returns undefined when the first line alone exceeded the byte limit', () => {
    const truncation = { truncated: true, outputLines: 0, firstLineExceedsLimit: true };

    expect(resolveReadRange({ offset: 5, limit: undefined, text: '[Line 5 is 80KB…]', truncation })).toBeUndefined();
  });

  test('image reads cover a single synthetic line so repeats still compare', () => {
    expect(resolveReadRange({ offset: undefined, limit: undefined, text: 'Read image', isImage: true })).toStrictEqual({
      start: 1,
      end: 1,
    });
  });

  test('falls back to offset/limit without text', () => {
    expect(resolveReadRange({ offset: 10, limit: 5, text: undefined })).toStrictEqual({ start: 10, end: 14 });
    expect(resolveReadRange({ offset: 0, limit: undefined, text: undefined })).toStrictEqual({
      start: 1,
      end: Infinity,
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatNudge
// ──────────────────────────────────────────────────────────────────────

describe('formatNudge', () => {
  test('same-slice nudge mentions the exact slice, covered lines, and scratchpad', () => {
    const h = new ReadHistory();

    h.record(probe('/src/foo.ts', 1, 100, { offset: 10, limit: 50, turn: 3 }));

    const decision = h.classify(probe('/src/foo.ts', 1, 100, { offset: 10, limit: 50, turn: 5 }));

    assertKind(decision, 'same-slice');

    const text = formatNudge({ displayPath: 'src/foo.ts', decision, currentTurn: 5 });

    expect(text).toContain(NUDGE_MARKER);
    expect(text).toContain('src/foo.ts');
    expect(text).toContain('already read this exact slice');
    expect(text).toContain('offset=10, limit=50');
    expect(text).toContain('lines 10-59 already in context');
    expect(text).toContain('scratchpad');
  });

  test('same-slice uses "last turn" when ago is 1', () => {
    const h = new ReadHistory();

    h.record(probe('/a', 1, 1, { turn: 4 }));

    const decision = h.classify(probe('/a', 1, 1, { turn: 5 }));

    assertKind(decision, 'same-slice');

    const text = formatNudge({ displayPath: 'a', decision, currentTurn: 5 });

    expect(text).toContain('last turn');
  });

  test('same-slice uses "earlier this turn" when ago is 0', () => {
    const h = new ReadHistory();

    h.record(probe('/a', 1, 1, { turn: 4 }));

    const decision = h.classify(probe('/a', 1, 1, { turn: 4 }));

    assertKind(decision, 'same-slice');

    const text = formatNudge({ displayPath: 'a', decision, currentTurn: 4 });

    expect(text).toContain('earlier this turn');
  });

  test('overlap nudge names the lines already in context and suggests rg + scratchpad', () => {
    const h = new ReadHistory();

    h.record(probe('/src/foo.ts', 1, 100, { offset: 400, limit: 561, turn: 2 }));

    const decision = h.classify(probe('/src/foo.ts', 1, 100, { offset: 300, limit: 700, turn: 4 }));

    assertKind(decision, 'overlap');

    const text = formatNudge({ displayPath: 'src/foo.ts', decision, currentTurn: 4 });

    expect(text).toContain('2 turns ago');
    expect(text).toContain('lines 400-960 already in context');
    expect(text).toContain('rg -n');
    expect(text).toContain('scratchpad');
  });

  test('full-file re-read renders "full file"', () => {
    const h = new ReadHistory();

    h.record(probe('/a', 1, 1, { turn: 1 }));

    const decision = h.classify(probe('/a', 1, 1, { turn: 2 }));

    assertKind(decision, 'same-slice');

    const text = formatNudge({ displayPath: 'a', decision, currentTurn: 2 });

    expect(text).toContain('full file');
  });

  test('custom marker is honored', () => {
    const h = new ReadHistory();

    h.record(probe('/a', 1, 1, { turn: 1 }));

    const decision = h.classify(probe('/a', 1, 1, { turn: 2 }));

    assertKind(decision, 'same-slice');

    const text = formatNudge({ displayPath: 'a', decision, currentTurn: 2, marker: '!! X' });

    expect(text).toContain('!! X');
    expect(text).not.toContain(NUDGE_MARKER);
  });
});

describe('describeLines', () => {
  test('formats single lines, ranges, lists, and open-ended ranges', () => {
    expect(describeLines([{ start: 7, end: 7 }])).toBe('line 7');
    expect(describeLines([{ start: 400, end: 960 }])).toBe('lines 400-960');
    expect(
      describeLines([
        { start: 1, end: 20 },
        { start: 40, end: 60 },
      ]),
    ).toBe('lines 1-20, 40-60');
    expect(describeLines([{ start: 5, end: Infinity }])).toBe('lines 5-EOF');
  });
});
