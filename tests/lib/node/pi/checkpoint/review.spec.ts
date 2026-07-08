/**
 * Tests for lib/node/pi/checkpoint/review.ts - pure review-row
 * construction + ordering.
 */

import { describe, expect, test, vi } from 'vitest';

import { buildReviewRow, sortReviewRows } from '../../../../../lib/node/pi/checkpoint/review.ts';
import type { FileTarget, ReviewRow } from '../../../../../lib/node/pi/checkpoint/types.ts';

const OPTS = { hideNoOpRows: true, conflictRowsDefaultChecked: false };

function target(over: Partial<FileTarget> = {}): FileTarget {
  return { path: 'a.txt', target: 'T', expectedCurrent: 'C', ...over };
}

describe('buildReviewRow', () => {
  test('clean-restore (disk == expectedCurrent) starts checked', () => {
    const row = buildReviewRow(target(), 'old\n', 'C', () => 'new\n', OPTS);
    expect(row?.status).toBe('clean-restore');
    expect(row?.checked).toBe(true);
    expect(row).toMatchObject({ currentText: 'old\n', targetText: 'new\n' });
  });

  test('conflict honors conflictRowsDefaultChecked', () => {
    const off = buildReviewRow(target(), 'x', 'other', () => 'y', OPTS);
    expect(off?.status).toBe('conflict');
    expect(off?.checked).toBe(false);
    const on = buildReviewRow(target(), 'x', 'other', () => 'y', {
      hideNoOpRows: true,
      conflictRowsDefaultChecked: true,
    });
    expect(on?.checked).toBe(true);
  });

  test('no-op is hidden when hideNoOpRows and never reads the target blob', () => {
    const readTarget = vi.fn<() => string | null>(() => 'unused');
    // disk hash equals the target hash -> no-op.
    const row = buildReviewRow(target(), 'x', 'T', readTarget, OPTS);
    expect(row).toBeUndefined();
    expect(readTarget).not.toHaveBeenCalled();
  });

  test('no-op is shown (unchecked) when hideNoOpRows is off', () => {
    const row = buildReviewRow(target(), 'x', 'T', () => 'y', {
      hideNoOpRows: false,
      conflictRowsDefaultChecked: false,
    });
    expect(row?.status).toBe('no-op');
    expect(row?.checked).toBe(false);
  });

  test('counts adds/dels from disk -> target', () => {
    const row = buildReviewRow(target(), 'a\nb\n', 'C', () => 'a\nb\nc\n', OPTS);
    expect(row?.adds).toBe(1);
    expect(row?.dels).toBe(0);
  });

  test('a null target hash means "file absent" on the target side', () => {
    const row = buildReviewRow(target({ target: null }), 'a\nb', 'C', () => null, OPTS);
    expect(row?.status).toBe('clean-restore');
    expect(row?.targetText).toBeNull();
    // Whole-file delete: every current line counts as a del.
    expect(row?.dels).toBe(2);
    expect(row?.adds).toBe(0);
  });
});

describe('sortReviewRows', () => {
  test('orders by target path and leaves the input untouched', () => {
    const rows: ReviewRow[] = ['c.txt', 'a.txt', 'b.txt'].map((path) => ({
      target: { path, target: null, expectedCurrent: null },
      status: 'clean-restore',
      adds: 0,
      dels: 0,
      currentText: null,
      targetText: null,
      checked: true,
    }));
    const sorted = sortReviewRows(rows);
    expect(sorted.map((r) => r.target.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    // Original array order is preserved (new array returned).
    expect(rows.map((r) => r.target.path)).toEqual(['c.txt', 'a.txt', 'b.txt']);
  });
});
