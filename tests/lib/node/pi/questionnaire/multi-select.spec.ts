/**
 * Tests for lib/node/pi/questionnaire/multi-select.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  clampCursor,
  digitToCursor,
  meetsMinSelect,
  sortedSelection,
  toggleSelection,
} from '../../../../../lib/node/pi/questionnaire/multi-select.ts';

test('clampCursor: clamps into range and floors empty lists at 0', () => {
  expect(clampCursor(2, 5)).toBe(2);
  expect(clampCursor(-3, 5)).toBe(0);
  expect(clampCursor(9, 5)).toBe(4);
  expect(clampCursor(0, 0)).toBe(0);
  expect(clampCursor(4, 0)).toBe(0);
});

test('digitToCursor: maps 1-based digit to clamped 0-based index', () => {
  expect(digitToCursor(1, 5)).toBe(0);
  expect(digitToCursor(3, 5)).toBe(2);
  // Past the end clamps to the last row (questionnaire jump behaviour).
  expect(digitToCursor(9, 3)).toBe(2);
});

test('digitToCursor: rejects out-of-range digits and empty lists', () => {
  expect(digitToCursor(0, 5)).toBeNull();
  expect(digitToCursor(10, 5)).toBeNull();
  expect(digitToCursor(2.5, 5)).toBeNull();
  expect(digitToCursor(3, 0)).toBeNull();
});

test('toggleSelection: adds and removes membership', () => {
  const set = new Set<number>();
  expect(toggleSelection(set, 2)).toBe('added');
  expect(set.has(2)).toBe(true);
  expect(toggleSelection(set, 2)).toBe('removed');
  expect(set.has(2)).toBe(false);
});

test('toggleSelection: honors maxSelect when adding, but always allows removal', () => {
  const set = new Set<number>([0, 1]);
  expect(toggleSelection(set, 2, 2)).toBe('blocked');
  expect(set.has(2)).toBe(false);
  // Removing an existing index is never blocked by maxSelect.
  expect(toggleSelection(set, 1, 2)).toBe('removed');
  // Now there is room again.
  expect(toggleSelection(set, 2, 2)).toBe('added');
});

test('meetsMinSelect: defaults minimum to 0', () => {
  expect(meetsMinSelect(0)).toBe(true);
  expect(meetsMinSelect(0, 1)).toBe(false);
  expect(meetsMinSelect(1, 1)).toBe(true);
  expect(meetsMinSelect(3, 2)).toBe(true);
});

test('sortedSelection: returns an ascending copy without mutating the set', () => {
  const set = new Set<number>([3, 0, 2]);
  expect(sortedSelection(set)).toEqual([0, 2, 3]);
  // Original set untouched (still insertion order internally).
  expect([...set]).toEqual([3, 0, 2]);
});
