/**
 * Deterministic render tests for the ContextOverlay viewport windowing
 * (lib/node/pi/ext/context-usage-overlay.ts). Model-independent: builds a
 * synthetic breakdown with more categories + longer leaf content than a short
 * terminal can show and asserts all three modes stay within the viewport
 * budget with scroll indicators, including after resizing.
 */

import { expect, test } from 'vitest';

import type { Theme } from '@earendil-works/pi-coding-agent';
import { type TUI, visibleWidth } from '@earendil-works/pi-tui';

import { ContextOverlay } from '../../../../../lib/node/pi/ext/context-usage-overlay.ts';
import type { Breakdown, CategoryNode } from '../../../../../lib/node/pi/context-usage/types.ts';

const theme = { fg: (_t: string, s: string): string => s, bold: (s: string): string => s } as unknown as Theme;

function makeTui(rows: number): TUI & { terminal: { rows: number; columns: number } } {
  return {
    terminal: { rows, columns: 100 },
    requestRender: (): void => {
      /* no-op */
    },
  } as unknown as TUI & { terminal: { rows: number; columns: number } };
}

// onClose/compact/export are unused in render-only tests.
const noop = (): void => {
  /* no-op */
};

function makeBreakdown(): Breakdown {
  // Many top-level categories overflow the legend; one leaf carries long
  // content that overflows the content viewer.
  const children: CategoryNode[] = Array.from({ length: 100 }, (_, i) => ({
    id: `c${i}`,
    label: `Category ${i} with a moderately long label`,
    tokens: 1000 - i * 10,
    content: i === 0 ? Array.from({ length: 200 }, (_, l) => `content line ${l}`).join('\n') : undefined,
  }));
  const root: CategoryNode = { id: 'root', label: 'Context window', tokens: 100000, children };
  return {
    root,
    estimatedUsed: 50000,
    realTokens: 48000,
    contextWindow: 100000,
    lastUsage: null,
  };
}

function makeOverlay(rows: number, tui = makeTui(rows), breakdown = makeBreakdown()): ContextOverlay {
  return new ContextOverlay({
    theme,
    tui,
    rebuild: () => breakdown,
    compact: noop,
    exportReport: () => '/tmp/report.md',
    done: noop,
  });
}

const VIEWPORT = (rows: number): number => Math.max(1, Math.floor(rows) - 2);

function expectBounded(lines: string[], rows: number, width: number): void {
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(rows));
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

test('ContextOverlay: tree view stays within the viewport on a short terminal', () => {
  const rows = 22;
  const overlay = makeOverlay(rows);
  const lines = overlay.render(100);
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(rows));
  // The legend scrolls: with 20 categories and a small budget, a "more"
  // indicator must appear.
  expect(lines.some((l) => l.includes('more'))).toBe(true);
});

test('ContextOverlay: content viewer stays within the viewport on a short terminal', () => {
  const rows = 22;
  const overlay = makeOverlay(rows);
  // Drill into the first category's content: Enter opens the leaf viewer.
  overlay.handleInput('\r');
  const lines = overlay.render(100);
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(rows));
  // Position footer proves the content was windowed (not dumped whole).
  expect(lines.some((l) => l.includes('/ 200'))).toBe(true);
});

test('ContextOverlay: taller terminal shows more content lines', () => {
  const short = makeOverlay(16);
  short.handleInput('\r');
  const shortLines = short.render(100);
  const tall = makeOverlay(44);
  tall.handleInput('\r');
  const tallLines = tall.render(100);
  expect(tallLines.length).toBeGreaterThan(shortLines.length);
  expect(tallLines.length).toBeLessThanOrEqual(VIEWPORT(44));
});

const MODES = ['tree', 'content', 'recon'] as const;

for (const mode of MODES) {
  test.each([1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 22])(
    `ContextOverlay: ${mode} is hard bounded at %i terminal rows, including narrow layouts`,
    (rows) => {
      for (const width of [18, 40, 55, 56, 100]) {
        const overlay = makeOverlay(rows);
        if (mode === 'content') overlay.handleInput('\r');
        if (mode === 'recon') overlay.handleInput('t');
        const lines = overlay.render(width);
        expectBounded(lines, rows, width);
        expect(lines.length).toBeLessThanOrEqual(VIEWPORT(rows));
      }
    },
  );

  test(`ContextOverlay: ${mode} rewindows on height and width changes without invalidation`, () => {
    const tui = makeTui(44);
    const overlay = makeOverlay(44, tui);
    if (mode === 'content') overlay.handleInput('\r');
    if (mode === 'recon') overlay.handleInput('t');
    const tall = overlay.render(100);
    expect(overlay.render(100)).toBe(tall);
    for (const [rows, width] of [
      [10, 40],
      [4, 18],
      [16, 100],
      [44, 40],
      [44, 100],
    ]) {
      tui.terminal.rows = rows;
      tui.terminal.columns = width;
      expectBounded(overlay.render(width), rows, width);
    }
    expect(overlay.render(100).length).toBe(tall.length);
  });
}

test.each([18, 40, 100])('ContextOverlay: selected category stays visible on a short terminal at width %i', (width) => {
  const tui = makeTui(10);
  const overlay = makeOverlay(10, tui);
  for (let i = 0; i < 100; i++) {
    const lines = overlay.render(width);
    expectBounded(lines, 10, width);
    expect(lines.some((line) => line.includes(`› ⛁ Category ${i}`))).toBe(true);
    expect(lines.at(-1)).toContain('↑/↓ select');
    if (i < 99) overlay.handleInput('\x1b[B');
  }
  // Shrinking the viewport must not hide the selection behind grid/header chrome.
  tui.terminal.rows = 5;
  const tiny = overlay.render(width);
  expectBounded(tiny, 5, width);
  expect(tiny.some((line) => line.includes('› ⛁ Category 99'))).toBe(true);
  tui.terminal.rows = 22;
  expect(overlay.render(width).some((line) => line.includes('› ⛁ Category 99'))).toBe(true);
});

test('ContextOverlay: reconciliation scrolls by arrows, pages, Home and End without moving the tree selection', () => {
  const breakdown = makeBreakdown();
  breakdown.lastUsage = { input: 1000, output: 100, cacheRead: 2000, cacheWrite: 500 };
  const overlay = makeOverlay(12, makeTui(12), breakdown);
  overlay.handleInput('t');
  const initial = overlay.render(100);
  expect(initial.some((line) => line.includes('Context window'))).toBe(true);
  expect(initial.some((line) => line.includes('cache-hit ratio'))).toBe(false);
  expect(initial.at(-1)).toContain('↑/↓ scroll');

  overlay.handleInput('\x1b[B');
  const down = overlay.render(100);
  expect(down).not.toEqual(initial);
  overlay.handleInput('\x1b[A');
  expect(overlay.render(100)).toEqual(initial);
  overlay.handleInput('\x1b[6~');
  const page = overlay.render(100);
  expect(page).not.toEqual(initial);
  expect(page).not.toEqual(down);
  overlay.handleInput('\x1b[5~');
  expect(overlay.render(100)).toEqual(initial);

  overlay.handleInput('\x1b[F');
  const end = overlay.render(100);
  expectBounded(end, 12, 100);
  expect(end.some((line) => line.includes('provider total is authoritative'))).toBe(true);
  expect(end.at(-1)).toContain('↑/↓ scroll');
  overlay.handleInput('\x1b[H');
  expect(overlay.render(100)).toEqual(initial);
  overlay.handleInput('t');
  expect(overlay.render(100).some((line) => line.includes('› ⛁ Category 0 '))).toBe(true);
});

test('ContextOverlay: content scroll and position footer survive shrinking and growing the terminal', () => {
  const tui = makeTui(22);
  const overlay = makeOverlay(22, tui);
  overlay.handleInput('\r');
  const initial = overlay.render(100);
  expect(initial.some((line) => line.includes('content line 0'))).toBe(true);
  overlay.handleInput('\x1b[6~');
  expect(overlay.render(100)).not.toEqual(initial);
  overlay.handleInput('\x1b[F');
  expect(overlay.render(100).some((line) => line.includes('content line 199'))).toBe(true);
  for (const rows of [8, 5, 16, 44]) {
    tui.terminal.rows = rows;
    overlay.handleInput('\x1b[F');
    const lines = overlay.render(100);
    expectBounded(lines, rows, 100);
    expect(lines.some((line) => line.includes('content line 199'))).toBe(true);
    expect(lines.at(-1)).toContain('/ 200');
  }
  overlay.handleInput('\x1b[H');
  expect(overlay.render(100).some((line) => line.includes('content line 0'))).toBe(true);
});
