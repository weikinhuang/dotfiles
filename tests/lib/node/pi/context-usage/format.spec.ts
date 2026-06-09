/**
 * Tests for lib/node/pi/context-usage/format.ts. Pure module.
 */

import { describe, expect, test } from 'vitest';

import {
  childrenTotal,
  clampScroll,
  formatAbsoluteShare,
  formatBar,
  formatBreadcrumb,
  formatPercent,
  formatTokens,
  formatTokensPct,
  sanitizeDetail,
  scrollWindow,
  wrapPlain,
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

describe('wrapPlain', () => {
  test('keeps short lines and blank lines', () => {
    expect(wrapPlain('a\n\nb', 80)).toEqual(['a', '', 'b']);
  });
  test('word-wraps at the last space before width', () => {
    expect(wrapPlain('the quick brown fox', 10)).toEqual(['the quick', 'brown fox']);
  });
  test('hard-breaks a word longer than width', () => {
    expect(wrapPlain('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
  test('expands tabs', () => {
    expect(wrapPlain('a\tb', 80)).toEqual(['a  b']);
  });
  test('non-positive width returns raw lines', () => {
    expect(wrapPlain('a\nb', 0)).toEqual(['a', 'b']);
  });
});

describe('clampScroll', () => {
  test('clamps to zero when content fits', () => {
    expect(clampScroll(5, 10, 24)).toBe(0);
  });
  test('clamps to the max top offset', () => {
    expect(clampScroll(100, 30, 24)).toBe(6);
  });
  test('negative offset clamps to zero', () => {
    expect(clampScroll(-3, 30, 24)).toBe(0);
  });
  test('mid-range offset preserved', () => {
    expect(clampScroll(3, 30, 24)).toBe(3);
  });
});
