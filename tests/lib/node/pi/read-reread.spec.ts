/**
 * Tests for lib/node/pi/read-reread.ts - pure module, no pi runtime.
 */

import { describe, expect, test } from 'vitest';

import { formatNudge, NUDGE_MARKER, ReadHistory, type RereadProbe } from '../../../../lib/node/pi/read-reread.ts';
import { assertKind } from './helpers.ts';

function probe(
  path: string,
  mtimeMs: number,
  size: number,
  opts: { offset?: number; limit?: number; turn?: number } = {},
): RereadProbe {
  return {
    sig: { path, mtimeMs, size },
    offset: opts.offset,
    limit: opts.limit,
    turn: opts.turn ?? 1,
  };
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

  test('same path + same signature + different offset → different-slice', () => {
    const h = new ReadHistory();
    h.record(probe('/a', 100, 50, { offset: 1, limit: 100 }));

    expect(h.classify(probe('/a', 100, 50, { offset: 101, limit: 100 })).kind).toBe('different-slice');
  });

  test('same path + same signature + different limit → different-slice', () => {
    const h = new ReadHistory();
    h.record(probe('/a', 100, 50, { offset: 1, limit: 100 }));

    expect(h.classify(probe('/a', 100, 50, { offset: 1, limit: 200 })).kind).toBe('different-slice');
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
  });

  test('exposes the previous record on non-first-time outcomes', () => {
    const h = new ReadHistory();

    h.record(probe('/a', 100, 50, { offset: 10, limit: 20, turn: 3 }));

    const out = h.classify(probe('/a', 100, 50, { offset: 10, limit: 20, turn: 9 }));

    assertKind(out, 'same-slice');

    expect(out.previous.turn).toBe(3);
    expect(out.previous.offset).toBe(10);
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
// formatNudge
// ──────────────────────────────────────────────────────────────────────

describe('formatNudge', () => {
  test('same-slice nudge mentions the exact slice and scratchpad', () => {
    const h = new ReadHistory();

    h.record(probe('/src/foo.ts', 1, 100, { offset: 10, limit: 50, turn: 3 }));

    const decision = h.classify(probe('/src/foo.ts', 1, 100, { offset: 10, limit: 50, turn: 5 }));

    assertKind(decision, 'same-slice');

    const text = formatNudge({ displayPath: 'src/foo.ts', decision, currentTurn: 5 });

    expect(text).toContain(NUDGE_MARKER);
    expect(text).toContain('src/foo.ts');
    expect(text).toContain('already read this exact slice');
    expect(text).toContain('offset=10, limit=50');
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

  test('different-slice nudge suggests rg and scratchpad carry-over', () => {
    const h = new ReadHistory();

    h.record(probe('/src/foo.ts', 1, 100, { offset: 1, limit: 50, turn: 2 }));

    const decision = h.classify(probe('/src/foo.ts', 1, 100, { offset: 51, limit: 50, turn: 4 }));

    assertKind(decision, 'different-slice');

    const text = formatNudge({ displayPath: 'src/foo.ts', decision, currentTurn: 4 });

    expect(text).toContain('2 turns ago');
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
