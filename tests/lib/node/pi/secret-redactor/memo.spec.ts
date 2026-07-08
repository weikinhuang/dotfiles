/**
 * Tests for lib/node/pi/secret-redactor/memo.ts.
 *
 * Pure module - no pi runtime. Covers compute-on-miss, cache-on-hit,
 * LRU eviction past `cap`, recency promotion on a hit, and `clear()`.
 */

import { describe, expect, test, vi } from 'vitest';

import { createLruMemo } from '../../../../../lib/node/pi/secret-redactor/memo.ts';

describe('createLruMemo', () => {
  test('computes on a miss and caches on the next hit', () => {
    const compute = vi.fn((k: string) => k.toUpperCase());
    const memo = createLruMemo(10, compute);

    expect(memo.get('a')).toBe('A');
    expect(memo.get('a')).toBe('A');
    expect(compute).toHaveBeenCalledTimes(1);
    expect(memo.size).toBe(1);
  });

  test('evicts the least-recently-used key once size exceeds cap', () => {
    const compute = vi.fn((k: string) => k.toUpperCase());
    const memo = createLruMemo(2, compute);

    memo.get('a'); // [a]
    memo.get('b'); // [a, b]
    memo.get('c'); // overflow -> evict 'a' -> [b, c]

    expect(memo.size).toBe(2);
    // 'a' was evicted, so re-fetching recomputes it.
    memo.get('a');
    expect(compute).toHaveBeenCalledTimes(4); // a, b, c, a-again
  });

  test('a hit promotes the key to most-recent, protecting it from eviction', () => {
    const compute = vi.fn((k: string) => k.toUpperCase());
    const memo = createLruMemo(2, compute);

    memo.get('a'); // [a]
    memo.get('b'); // [a, b]
    memo.get('a'); // hit -> promote a -> [b, a]
    memo.get('c'); // overflow -> evict 'b' (now oldest) -> [a, c]

    // 'a' is still cached (no recompute); 'b' was evicted.
    memo.get('a');
    expect(compute).toHaveBeenCalledTimes(3); // a, b, c (a-hits recomputed nothing)
  });

  test('clear() drops every entry', () => {
    const compute = vi.fn((k: string) => k.toUpperCase());
    const memo = createLruMemo(10, compute);

    memo.get('a');
    memo.get('b');
    expect(memo.size).toBe(2);

    memo.clear();
    expect(memo.size).toBe(0);
    memo.get('a'); // recomputes after clear
    expect(compute).toHaveBeenCalledTimes(3);
  });
});
