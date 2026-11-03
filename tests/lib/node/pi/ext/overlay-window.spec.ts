/**
 * Tests for lib/node/pi/ext/overlay-window.ts.
 */

import { expect, test } from 'vitest';

import type { Theme } from '@earendil-works/pi-coding-agent';

import { assembleWindowedBody, overlayViewportRows } from '../../../../../lib/node/pi/ext/overlay-window.ts';

// Minimal theme stub: fg returns the text unchanged so indicator rows are
// plain and easy to assert on.
const theme = { fg: (_token: string, text: string): string => text } as unknown as Theme;

const body = (n: number): string[] => Array.from({ length: n }, (_, i) => `line${i}`);

test('overlayViewportRows: subtracts the margin without inflating tiny terminals', () => {
  expect(overlayViewportRows(30)).toBe(28);
  expect(overlayViewportRows(4)).toBe(2);
  expect(overlayViewportRows(1)).toBe(1);
});

test.each([0, 1, 2, 3, 4, 5, 6, 8, 12])('assembleWindowedBody: hard-bounds a %i-row viewport', (rows) => {
  const r = assembleWindowedBody({
    header: ['', 'Title', '', 'Summary'],
    body: body(100),
    footer: ['', 'Preview', 'Detail', '', 'Help', ''],
    width: 40,
    viewportRows: rows,
    scrollTop: 0,
    theme,
    keepStart: 99,
    keepEnd: 100,
  });
  expect(r.lines.length).toBeLessThanOrEqual(rows);
  expect(r.lines.includes('line99')).toBe(rows > 0);
  expect(r.lines.includes('Help')).toBe(rows >= 3);
});

test.each([1, 2])('assembleWindowedBody: does not overallocate indicators in a %i-row body', (rows) => {
  const r = assembleWindowedBody({
    header: ['Title'],
    body: body(100),
    footer: ['Help'],
    width: 40,
    viewportRows: rows + 2,
    scrollTop: 50,
    theme,
  });
  expect(r.lines.length).toBe(rows + 2);
  expect(r.lines[0]).toBe('Title');
  expect(r.lines.at(-1)).toBe('Help');
});

test('assembleWindowedBody: body that fits renders whole with no indicators', () => {
  const r = assembleWindowedBody({
    header: ['H'],
    body: body(5),
    footer: ['F'],
    width: 40,
    viewportRows: 10,
    scrollTop: 3,
    theme,
  });
  expect(r.lines).toEqual(['H', 'line0', 'line1', 'line2', 'line3', 'line4', 'F']);
  expect(r.scrollTop).toBe(0);
  expect(r.maxScrollTop).toBe(0);
});

test('assembleWindowedBody: tall body reserves two indicator rows and slices', () => {
  // viewportRows 10, header 1 + footer 1 => regionRows 8 => contentRows 6.
  const r = assembleWindowedBody({
    header: ['H'],
    body: body(20),
    footer: ['F'],
    width: 40,
    viewportRows: 10,
    scrollTop: 5,
    theme,
  });
  expect(r.contentRows).toBe(6);
  expect(r.maxScrollTop).toBe(14);
  expect(r.scrollTop).toBe(5);
  // header + topIndicator + 6 body lines + bottomIndicator + footer = 10 rows.
  expect(r.lines.length).toBe(10);
  expect(r.lines[0]).toBe('H');
  expect(r.lines[1]).toBe('  ↑ 5 more');
  expect(r.lines.slice(2, 8)).toEqual(['line5', 'line6', 'line7', 'line8', 'line9', 'line10']);
  expect(r.lines[8]).toBe('  ↓ 9 more');
  expect(r.lines[9]).toBe('F');
});

test('assembleWindowedBody: at top the up-indicator row is blank', () => {
  const r = assembleWindowedBody({
    header: [],
    body: body(20),
    footer: [],
    width: 40,
    viewportRows: 8,
    scrollTop: 0,
    theme,
  });
  expect(r.lines[0]).toBe(''); // no "↑ more" at the top
  expect(r.lines.at(-1)).toBe('  ↓ 14 more');
});

test('assembleWindowedBody: stale scrollTop past the end is clamped', () => {
  const r = assembleWindowedBody({
    header: [],
    body: body(20),
    footer: [],
    width: 40,
    viewportRows: 8,
    scrollTop: 999,
    theme,
  });
  expect(r.scrollTop).toBe(r.maxScrollTop);
});

test('assembleWindowedBody: keepEnd taller than region scrolls to reveal it', () => {
  // Selection-driven: keep line 18 visible.
  const r = assembleWindowedBody({
    header: [],
    body: body(20),
    footer: [],
    width: 40,
    viewportRows: 8,
    scrollTop: 0,
    theme,
    keepStart: 18,
    keepEnd: 19,
  });
  expect(r.winStart).toBeLessThanOrEqual(18);
  expect(r.winEnd).toBeGreaterThanOrEqual(19);
});
