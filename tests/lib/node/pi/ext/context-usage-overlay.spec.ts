/**
 * Deterministic render tests for the ContextOverlay viewport windowing
 * (lib/node/pi/ext/context-usage-overlay.ts). Model-independent: builds a
 * synthetic breakdown with more categories + longer leaf content than a short
 * terminal can show and asserts the tree view and the content viewer both stay
 * within the viewport budget with scroll indicators.
 */

import { expect, test } from 'vitest';

import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';

import { ContextOverlay } from '../../../../../lib/node/pi/ext/context-usage-overlay.ts';
import type { Breakdown, CategoryNode } from '../../../../../lib/node/pi/context-usage/types.ts';

const theme = { fg: (_t: string, s: string): string => s, bold: (s: string): string => s } as unknown as Theme;

function makeTui(rows: number): TUI {
  return {
    terminal: { rows, columns: 100 },
    requestRender: (): void => {
      /* no-op */
    },
  } as unknown as TUI;
}

// onClose/compact/export are unused in render-only tests.
const noop = (): void => {
  /* no-op */
};

function makeBreakdown(): Breakdown {
  // 20 top-level categories (overflow the legend); one leaf carries long
  // content (overflow the content viewer).
  const children: CategoryNode[] = Array.from({ length: 20 }, (_, i) => ({
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

function makeOverlay(rows: number): ContextOverlay {
  return new ContextOverlay({
    theme,
    tui: makeTui(rows),
    rebuild: makeBreakdown,
    compact: noop,
    exportReport: () => '/tmp/report.md',
    done: noop,
  });
}

const VIEWPORT = (rows: number): number => Math.max(6, rows - 2);

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
