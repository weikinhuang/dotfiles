/**
 * Tests for lib/node/pi/context-usage/format.ts. Pure module.
 */

import { describe, expect, test } from 'vitest';

import {
  childrenTotal,
  formatAbsoluteShare,
  formatBar,
  formatBreadcrumb,
  formatPercent,
  formatTokens,
  formatTokensPct,
  sanitizeDetail,
  scrollWindow,
} from '../../../../../lib/node/pi/context-usage/format.ts';
import type { CategoryNode } from '../../../../../lib/node/pi/context-usage/types.ts';

describe('formatPercent', () => {
  test('zero total → 0%', () => {
    expect(formatPercent(5, 0)).toBe('0%');
  });
  test('whole number at/above 10%', () => {
    expect(formatPercent(50, 100)).toBe('50%');
  });
  test('one decimal under 10%', () => {
    expect(formatPercent(3.1, 100)).toBe('3.1%');
  });
  test('tiny non-zero → <0.1%', () => {
    expect(formatPercent(1, 100000)).toBe('<0.1%');
  });
});

describe('formatTokensPct', () => {
  test('combines fmtSi tokens and percent', () => {
    expect(formatTokensPct(6300, 200000)).toBe('6k  3.1%');
  });
});

describe('formatBreadcrumb', () => {
  test('prefixes /context and joins with arrows', () => {
    expect(formatBreadcrumb(['System prompt', 'Context files'])).toBe('/context › System prompt › Context files');
  });
  test('bare root', () => {
    expect(formatBreadcrumb([])).toBe('/context');
  });
});

describe('formatAbsoluteShare', () => {
  test('renders tokens · pct of window', () => {
    expect(formatAbsoluteShare(6300, 200000)).toBe('6k · 3.1% of 200k window');
  });
});

describe('formatBar', () => {
  test('proportional fill', () => {
    expect(formatBar(50, 100, 10)).toBe('█████░░░░░');
  });
  test('zero total → all empty', () => {
    expect(formatBar(0, 0, 4)).toBe('░░░░');
  });
  test('clamps over-full', () => {
    expect(formatBar(200, 100, 4)).toBe('████');
  });
});

describe('childrenTotal', () => {
  test('sums children tokens', () => {
    const node: CategoryNode = {
      id: 'r',
      label: 'r',
      tokens: 999,
      children: [
        { id: 'a', label: 'a', tokens: 10 },
        { id: 'b', label: 'b', tokens: 20 },
      ],
    };
    expect(childrenTotal(node)).toBe(30);
  });
  test('leaf → 0', () => {
    expect(childrenTotal({ id: 'x', label: 'x', tokens: 5 })).toBe(0);
  });
});

test('formatTokens re-exported from token-format', () => {
  expect(formatTokens(1500)).toBe('2k');
});

describe('scrollWindow', () => {
  test('returns full range when everything fits', () => {
    expect(scrollWindow(5, 0, 12)).toEqual({ start: 0, end: 5 });
    expect(scrollWindow(12, 11, 12)).toEqual({ start: 0, end: 12 });
  });
  test('centers the selection when overflowing', () => {
    expect(scrollWindow(40, 20, 10)).toEqual({ start: 15, end: 25 });
  });
  test('clamps to the start', () => {
    expect(scrollWindow(40, 1, 10)).toEqual({ start: 0, end: 10 });
  });
  test('clamps to the end', () => {
    expect(scrollWindow(40, 39, 10)).toEqual({ start: 30, end: 40 });
  });
  test('zero maxVisible → empty range', () => {
    expect(scrollWindow(40, 5, 0)).toEqual({ start: 0, end: 40 });
  });
});

describe('sanitizeDetail', () => {
  test('collapses whitespace and newlines', () => {
    expect(sanitizeDetail('a\n\n  b\tc')).toBe('a b c');
  });
  test('truncates with ellipsis', () => {
    expect(sanitizeDetail('x'.repeat(120), 10)).toBe(`${'x'.repeat(9)}…`);
  });
  test('leaves short text intact', () => {
    expect(sanitizeDetail('short')).toBe('short');
  });
});
