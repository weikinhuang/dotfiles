/**
 * Tests for lib/node/pi/scroll-window.ts.
 */

import { expect, test } from 'vitest';

import { computeScrollWindow } from '../../../../lib/node/pi/scroll-window.ts';

test('computeScrollWindow: empty list yields an empty window', () => {
  expect(computeScrollWindow({ total: 0, rows: 10, scrollTop: 0 })).toEqual({
    start: 0,
    end: 0,
    scrollTop: 0,
    hiddenAbove: 0,
    hiddenBelow: 0,
  });
});

test('computeScrollWindow: zero rows shows nothing but reports all hidden below', () => {
  expect(computeScrollWindow({ total: 5, rows: 0, scrollTop: 0 })).toEqual({
    start: 0,
    end: 0,
    scrollTop: 0,
    hiddenAbove: 0,
    hiddenBelow: 5,
  });
});

test('computeScrollWindow: content shorter than budget fits with no scroll', () => {
  expect(computeScrollWindow({ total: 4, rows: 10, scrollTop: 3 })).toEqual({
    start: 0,
    end: 4,
    scrollTop: 0,
    hiddenAbove: 0,
    hiddenBelow: 0,
  });
});

test('computeScrollWindow: honors a valid previous offset', () => {
  const w = computeScrollWindow({ total: 20, rows: 5, scrollTop: 4 });
  expect(w).toEqual({ start: 4, end: 9, scrollTop: 4, hiddenAbove: 4, hiddenBelow: 11 });
});

test('computeScrollWindow: clamps a stale offset past the end', () => {
  const w = computeScrollWindow({ total: 20, rows: 5, scrollTop: 999 });
  // maxScrollTop = 20 - 5 = 15.
  expect(w).toEqual({ start: 15, end: 20, scrollTop: 15, hiddenAbove: 15, hiddenBelow: 0 });
});

test('computeScrollWindow: clamps a negative offset to zero', () => {
  const w = computeScrollWindow({ total: 20, rows: 5, scrollTop: -3 });
  expect(w).toEqual({ start: 0, end: 5, scrollTop: 0, hiddenAbove: 0, hiddenBelow: 15 });
});

test('computeScrollWindow: scrolls down to reveal a selection below the fold', () => {
  // Selecting line 12 (single-line range) with the window at the top.
  const w = computeScrollWindow({ total: 20, rows: 5, scrollTop: 0, keepStart: 12, keepEnd: 13 });
  // keepEnd 13 > 0 + 5, so scrollTop = 13 - 5 = 8.
  expect(w).toEqual({ start: 8, end: 13, scrollTop: 8, hiddenAbove: 8, hiddenBelow: 7 });
});

test('computeScrollWindow: scrolls up to reveal a selection above the window', () => {
  const w = computeScrollWindow({ total: 20, rows: 5, scrollTop: 10, keepStart: 3, keepEnd: 4 });
  // keepStart 3 < 10, so scrollTop = 3.
  expect(w).toEqual({ start: 3, end: 8, scrollTop: 3, hiddenAbove: 3, hiddenBelow: 12 });
});

test('computeScrollWindow: no scroll when the selection is already in view', () => {
  const w = computeScrollWindow({ total: 20, rows: 5, scrollTop: 6, keepStart: 7, keepEnd: 9 });
  expect(w).toEqual({ start: 6, end: 11, scrollTop: 6, hiddenAbove: 6, hiddenBelow: 9 });
});

test('computeScrollWindow: a selection taller than the budget is top-anchored', () => {
  // A wrapped note spanning lines 10..18 (8 lines) into a 5-row region:
  // reveal end pulls to 13, then reveal start pulls back to 10 (start wins).
  const w = computeScrollWindow({ total: 20, rows: 5, scrollTop: 0, keepStart: 10, keepEnd: 18 });
  expect(w).toEqual({ start: 10, end: 15, scrollTop: 10, hiddenAbove: 10, hiddenBelow: 5 });
});

test('computeScrollWindow: clamps out-of-range keep indices', () => {
  const w = computeScrollWindow({ total: 20, rows: 5, scrollTop: 0, keepStart: 50, keepEnd: 99 });
  // Clamped to total; reveal end pulls scrollTop to 15 (maxScrollTop).
  expect(w).toEqual({ start: 15, end: 20, scrollTop: 15, hiddenAbove: 15, hiddenBelow: 0 });
});

test('computeScrollWindow: floors fractional inputs', () => {
  const w = computeScrollWindow({ total: 20.9, rows: 5.9, scrollTop: 4.7 });
  expect(w).toEqual({ start: 4, end: 9, scrollTop: 4, hiddenAbove: 4, hiddenBelow: 11 });
});
