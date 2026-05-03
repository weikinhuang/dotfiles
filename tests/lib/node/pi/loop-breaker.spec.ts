/**
 * Tests for lib/node/pi/loop-breaker.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import { buildNudge, makeKey, pushAndCheck, stableStringify } from '../../../../lib/node/pi/loop-breaker.ts';

// ──────────────────────────────────────────────────────────────────────
// stableStringify
// ──────────────────────────────────────────────────────────────────────

describe('stableStringify', () => {
  test('produces the same output regardless of key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  test('stable across nested objects', () => {
    const a = stableStringify({ outer: { b: 2, a: 1 }, other: 3 });
    const b = stableStringify({ other: 3, outer: { a: 1, b: 2 } });

    expect(a).toBe(b);
  });

  test('preserves array order (arrays are position-sensitive)', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  test('primitives', () => {
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe(undefined);
  });

  test('handles cycles without throwing', () => {
    const a: Record<string, unknown> = {};
    a.self = a;

    expect(() => stableStringify(a)).not.toThrow();
    expect(stableStringify(a)).toContain('[Circular]');
  });
});

// ──────────────────────────────────────────────────────────────────────
// makeKey
// ──────────────────────────────────────────────────────────────────────

describe('makeKey', () => {
  test('different tools with same input produce different keys', () => {
    expect(makeKey('bash', { command: 'ls' })).not.toBe(makeKey('grep', { command: 'ls' }));
  });

  test('same tool with key-reordered input produces the same key', () => {
    expect(makeKey('bash', { command: 'ls', timeout: 10 })).toBe(makeKey('bash', { timeout: 10, command: 'ls' }));
  });

  test('handles undefined input gracefully', () => {
    expect(makeKey('bash', undefined)).toBe('bash::{}');
  });
});

// ──────────────────────────────────────────────────────────────────────
// pushAndCheck
// ──────────────────────────────────────────────────────────────────────

describe('pushAndCheck', () => {
  test('no repeats → ok', () => {
    const h: string[] = [];

    expect(pushAndCheck(h, 'a', 6, 3)).toEqual({ kind: 'ok' });
    expect(pushAndCheck(h, 'b', 6, 3)).toEqual({ kind: 'ok' });
    expect(pushAndCheck(h, 'c', 6, 3)).toEqual({ kind: 'ok' });
  });

  test('N repeats → repeat with count=N', () => {
    const h: string[] = [];
    pushAndCheck(h, 'a', 6, 3);
    pushAndCheck(h, 'a', 6, 3);
    const result = pushAndCheck(h, 'a', 6, 3);

    expect(result).toEqual({ kind: 'repeat', count: 3 });
  });

  test('trimming — old entries drop out of the window', () => {
    const h: string[] = [];
    // Fill the window with 'a' then push 6 non-'a's; now 'a' should be evicted.
    pushAndCheck(h, 'a', 6, 3);
    for (let i = 0; i < 6; i++) pushAndCheck(h, `b${i}`, 6, 3);

    // History now holds the last 6 b-items; an 'a' shouldn't count prior 'a'.
    expect(pushAndCheck(h, 'a', 6, 3)).toEqual({ kind: 'ok' });
  });

  test('mutates history array in place (caller keeps using it)', () => {
    const h: string[] = [];
    pushAndCheck(h, 'x', 6, 3);

    expect(h).toEqual(['x']);

    pushAndCheck(h, 'x', 6, 3);

    expect(h).toEqual(['x', 'x']);
  });

  test('threshold exactly met triggers', () => {
    const h: string[] = [];
    pushAndCheck(h, 'z', 6, 2);

    expect(pushAndCheck(h, 'z', 6, 2)).toEqual({ kind: 'repeat', count: 2 });
  });

  test('invalid window or threshold returns ok', () => {
    expect(pushAndCheck([], 'a', 0, 3)).toEqual({ kind: 'ok' });
    expect(pushAndCheck([], 'a', 5, 0)).toEqual({ kind: 'ok' });
  });

  test('interleaved keys do not prematurely trigger', () => {
    const h: string[] = [];
    pushAndCheck(h, 'a', 6, 3);
    pushAndCheck(h, 'b', 6, 3);
    pushAndCheck(h, 'a', 6, 3);
    pushAndCheck(h, 'b', 6, 3);
    // 'a' appears twice in-window, 'b' appears twice — neither hit threshold=3 yet.
    const third = pushAndCheck(h, 'a', 6, 3);

    expect(third).toEqual({ kind: 'repeat', count: 3 });
  });

  test('repeat beyond threshold reports larger count if caller does not reset', () => {
    const h: string[] = [];
    pushAndCheck(h, 'a', 6, 3);
    pushAndCheck(h, 'a', 6, 3);
    pushAndCheck(h, 'a', 6, 3);
    const r = pushAndCheck(h, 'a', 6, 3);

    expect(r).toEqual({ kind: 'repeat', count: 4 });
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildNudge
// ──────────────────────────────────────────────────────────────────────

describe('buildNudge', () => {
  test('mentions the tool and count', () => {
    const s = buildNudge('bash', 3);

    expect(s).toContain('bash');
    expect(s).toContain('3');
  });

  test('tells the model to change approach', () => {
    const s = buildNudge('read', 3);

    expect(s).toMatch(/different approach|change the arguments/i);
  });

  test('is concise (under 400 chars)', () => {
    // Weak models absorb short nudges better than long philosophical ones.
    expect(buildNudge('bash', 5).length).toBeLessThan(400);
  });
});
