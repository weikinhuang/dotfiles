/**
 * Tests for lib/node/pi/token-format.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import { cacheHitRatioPct, fmtCost, fmtSi, formatUsageLine } from '../../../../lib/node/pi/token-format.ts';

describe('fmtSi', () => {
  test('sub-thousand values render as bare integers', () => {
    expect(fmtSi(0)).toBe('0');
    expect(fmtSi(1)).toBe('1');
    expect(fmtSi(999)).toBe('999');
  });

  test('handles non-finite + negative numbers as zero', () => {
    expect(fmtSi(NaN)).toBe('0');
    expect(fmtSi(-5)).toBe('0');
    expect(fmtSi(Infinity)).toBe('0'); // rejected alongside negatives
  });

  test('1k–999k renders as rounded kilos', () => {
    expect(fmtSi(1000)).toBe('1k');
    expect(fmtSi(1499)).toBe('1k');
    expect(fmtSi(1500)).toBe('2k');
    expect(fmtSi(12_345)).toBe('12k');
    expect(fmtSi(999_499)).toBe('999k');
  });

  test('1M–10M renders with two fractional digits', () => {
    expect(fmtSi(1_000_000)).toBe('1.00M');
    expect(fmtSi(1_234_567)).toBe('1.23M');
    expect(fmtSi(9_999_999)).toBe('10.00M');
  });

  test('≥10M renders with one fractional digit', () => {
    expect(fmtSi(10_000_000)).toBe('10.0M');
    expect(fmtSi(123_456_789)).toBe('123.5M');
  });
});

describe('fmtCost', () => {
  test('three-decimal dollar precision', () => {
    expect(fmtCost(0)).toBe('$0.000');
    expect(fmtCost(0.0012)).toBe('$0.001');
    expect(fmtCost(1.23456)).toBe('$1.235');
  });
});

describe('cacheHitRatioPct', () => {
  test('zero denominator → null', () => {
    expect(cacheHitRatioPct({ input: 0, cacheRead: 0 })).toBeNull();
  });

  test('rounds to an integer percent', () => {
    expect(cacheHitRatioPct({ input: 100, cacheRead: 0 })).toBe(0);
    expect(cacheHitRatioPct({ input: 100, cacheRead: 100 })).toBe(50);
    expect(cacheHitRatioPct({ input: 0, cacheRead: 100 })).toBe(100);
    expect(cacheHitRatioPct({ input: 17, cacheRead: 83 })).toBe(83);
  });
});

describe('formatUsageLine', () => {
  test('omits cache-write segment when zero', () => {
    const out = formatUsageLine({ input: 1000, cacheRead: 2000, output: 500 });

    expect(out).toBe('↑1k/↻ 2k/↓500');
  });

  test('includes cache-write segment when non-zero', () => {
    const out = formatUsageLine({ input: 1000, cacheRead: 2000, cacheWrite: 500, output: 300 });

    expect(out).toBe('↑1k/↻ 2k/W 500/↓300');
  });

  test('appends ratio when requested', () => {
    const out = formatUsageLine({ input: 100, cacheRead: 900, output: 50 }, { includeRatio: true });

    expect(out).toBe('↑100/↻ 900/↓50 R 90%');
  });

  test('ratio omitted when denominator zero even if requested', () => {
    const out = formatUsageLine({ input: 0, cacheRead: 0, output: 50 }, { includeRatio: true });

    expect(out).toBe('↑0/↻ 0/↓50');
  });
});
