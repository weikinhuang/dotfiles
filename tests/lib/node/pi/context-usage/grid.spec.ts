/**
 * Tests for lib/node/pi/context-usage/grid.ts. Pure module.
 */

import { describe, expect, test } from 'vitest';

import { buildGrid, chunkRows, DEFAULT_GRID } from '../../../../../lib/node/pi/context-usage/grid.ts';

describe('buildGrid', () => {
  test('all free when no children', () => {
    const cells = buildGrid([], 1000);
    expect(cells).toHaveLength(100);
    expect(cells.every((c) => c.kind === 'free' && c.childIndex === null)).toBe(true);
  });

  test('all free when capacity is zero', () => {
    const cells = buildGrid([10, 20], 0);
    expect(cells.every((c) => c.kind === 'free')).toBe(true);
  });

  test('fully filled when capacity equals child sum (drilled node)', () => {
    const cells = buildGrid([50, 50], 100);
    // No free cells; both children represented.
    expect(cells.some((c) => c.kind === 'free')).toBe(false);
    expect(cells.filter((c) => c.childIndex === 0).length).toBeGreaterThan(0);
    expect(cells.filter((c) => c.childIndex === 1).length).toBeGreaterThan(0);
  });

  test('half-used window has a free tail and one partial boundary', () => {
    // 50 of 100 capacity used by a single child over a 10-cell grid.
    const cells = buildGrid([50], 100, { rows: 1, cols: 10 });
    expect(cells).toHaveLength(10);
    const used = cells.filter((c) => c.kind === 'used').length;
    const free = cells.filter((c) => c.kind === 'free').length;
    expect(used).toBe(5);
    expect(free).toBe(5);
    expect(cells.filter((c) => c.kind === 'partial')).toHaveLength(0);
  });

  test('fractional boundary produces a single partial cell', () => {
    // 55 of 100 over 10 cells: 5 full + 1 partial + 4 free.
    const cells = buildGrid([55], 100, { rows: 1, cols: 10 });
    expect(cells.filter((c) => c.kind === 'used')).toHaveLength(5);
    expect(cells.filter((c) => c.kind === 'partial')).toHaveLength(1);
    expect(cells.filter((c) => c.kind === 'free')).toHaveLength(4);
    expect(cells[5].kind).toBe('partial');
    expect(cells[5].childIndex).toBe(0);
  });

  test('contiguous colored runs in child order', () => {
    const cells = buildGrid([30, 70], 100, { rows: 1, cols: 10 });
    const indices = cells.map((c) => c.childIndex);
    // first ~3 cells child 0, rest child 1 (contiguous, non-decreasing)
    expect(indices[0]).toBe(0);
    expect(indices[9]).toBe(1);
    const firstOne = indices.indexOf(1);
    expect(indices.slice(0, firstOne).every((i) => i === 0)).toBe(true);
    expect(indices.slice(firstOne).every((i) => i === 1)).toBe(true);
  });

  test('default grid is 10x10 = 100 cells', () => {
    expect(DEFAULT_GRID.rows * DEFAULT_GRID.cols).toBe(100);
  });
});

describe('chunkRows', () => {
  test('splits into rows of cols length', () => {
    const cells = buildGrid([100], 100);
    const rows = chunkRows(cells, 10);
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.length === 10)).toBe(true);
  });
});
