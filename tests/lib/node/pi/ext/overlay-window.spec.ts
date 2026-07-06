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

test('overlayViewportRows: floors at MIN_OVERLAY_ROWS and subtracts the margin', () => {
  expect(overlayViewportRows(30)).toBe(28);
  expect(overlayViewportRows(4)).toBe(6); // clamps up to MIN
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
