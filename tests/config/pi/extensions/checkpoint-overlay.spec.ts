/**
 * Deterministic render tests for the checkpoint ReviewOverlay viewport
 * windowing (config/pi/extensions/checkpoint.ts). Model-independent: builds a
 * synthetic review with more files (and a longer diff) than a short terminal
 * can show and asserts both the file list and the drill-down diff viewer stay
 * within the viewport budget.
 */

import { beforeAll, expect, test } from 'vitest';

import type { Theme } from '@earendil-works/pi-coding-agent';
import { initTheme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';

import { ReviewOverlay } from '../../../../config/pi/extensions/checkpoint.ts';
import type { FileTarget } from '../../../../lib/node/pi/checkpoint/types.ts';

// The diff drill-down calls pi's renderDiff, which reads the global theme.
beforeAll(() => {
  initTheme(undefined, false);
});

const theme = { fg: (_t: string, s: string): string => s, bold: (s: string): string => s } as unknown as Theme;

function makeTui(rows: number): TUI {
  return {
    terminal: { rows, columns: 100 },
    requestRender: (): void => {
      /* no-op */
    },
  } as unknown as TUI;
}

const noop = (): void => {
  /* no-op */
};

interface Row {
  target: FileTarget;
  status: 'clean-restore';
  adds: number;
  dels: number;
  currentText: string;
  targetText: string;
  checked: boolean;
}

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const current = Array.from({ length: 80 }, (_, l) => `old line ${l} in file ${i}`).join('\n');
    const target = Array.from({ length: 80 }, (_, l) => `new line ${l} in file ${i}`).join('\n');
    return {
      target: { path: `src/file-${i}.ts`, target, expectedCurrent: current },
      status: 'clean-restore' as const,
      adds: 80,
      dels: 80,
      currentText: current,
      targetText: target,
      checked: false,
    };
  });
}

function makeOverlay(rows: number, fileCount: number): ReviewOverlay {
  return new ReviewOverlay(theme, makeRows(fileCount) as never, makeTui(rows), noop);
}

const VIEWPORT = (rows: number): number => Math.max(6, rows - 2);

test('ReviewOverlay: long file list stays within the viewport', () => {
  const rows = 20;
  const overlay = makeOverlay(rows, 40);
  const lines = overlay.render(100);
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(rows));
  expect(lines.some((l) => l.includes('more'))).toBe(true);
});

test('ReviewOverlay: diff viewer stays within the viewport on a short terminal', () => {
  const rows = 20;
  const overlay = makeOverlay(rows, 5);
  overlay.handleInput('\r'); // Enter -> open the diff drill-down
  const lines = overlay.render(100);
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(rows));
  // Position footer proves the diff was windowed, not dumped whole.
  expect(lines.some((l) => l.includes('scroll') && l.includes('/'))).toBe(true);
});

test('ReviewOverlay: a taller terminal shows more diff lines', () => {
  const short = makeOverlay(16, 5);
  short.handleInput('\r');
  const shortLines = short.render(100);
  const tall = makeOverlay(48, 5);
  tall.handleInput('\r');
  const tallLines = tall.render(100);
  expect(tallLines.length).toBeGreaterThan(shortLines.length);
  expect(tallLines.length).toBeLessThanOrEqual(VIEWPORT(48));
});

test('ReviewOverlay: a short file list is not windowed', () => {
  const overlay = makeOverlay(40, 3);
  const lines = overlay.render(100);
  expect(lines.some((l) => l.includes('more'))).toBe(false);
});
