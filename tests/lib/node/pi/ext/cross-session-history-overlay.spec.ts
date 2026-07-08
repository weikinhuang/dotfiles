/**
 * Deterministic render tests for the ReverseSearchOverlay viewport windowing
 * (lib/node/pi/ext/cross-session-history-overlay.ts). Model-independent: builds
 * a search overlay with more prompts than a short terminal can show and asserts
 * the rendered box stays within the viewport, shrinking the visible-row budget.
 */

import { expect, test } from 'vitest';

import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';

import { ReverseSearchOverlay } from '../../../../../lib/node/pi/ext/cross-session-history-overlay.ts';

const theme = { fg: (_t: string, s: string): string => s, bold: (s: string): string => s } as unknown as Theme;

function makeTui(rows: number): TUI {
  return {
    terminal: { rows, columns: 100 },
    requestRender: (): void => {
      /* no-op */
    },
  } as unknown as TUI;
}

const prompts = (n: number): string[] => Array.from({ length: n }, (_, i) => `prompt number ${i} with some text`);

const VIEWPORT = (rows: number): number => Math.max(6, rows - 2);

test('ReverseSearchOverlay: box stays within the viewport on a short terminal', () => {
  const rows = 12;
  const overlay = new ReverseSearchOverlay(theme, prompts(50), makeTui(rows));
  const lines = overlay.render(100);
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(rows));
});

test('ReverseSearchOverlay: a tall terminal shows the full 10-row cap', () => {
  const overlay = new ReverseSearchOverlay(theme, prompts(50), makeTui(40));
  const lines = overlay.render(100);
  // top border + query + 10 result rows + help + bottom border = 14.
  expect(lines.length).toBe(14);
});

test('ReverseSearchOverlay: short terminal shows fewer rows than a tall one', () => {
  const short = new ReverseSearchOverlay(theme, prompts(50), makeTui(12)).render(100);
  const tall = new ReverseSearchOverlay(theme, prompts(50), makeTui(40)).render(100);
  expect(short.length).toBeLessThan(tall.length);
});

test('ReverseSearchOverlay: no tui falls back to the fixed cap without crashing', () => {
  const overlay = new ReverseSearchOverlay(theme, prompts(50));
  const lines = overlay.render(100);
  expect(lines.length).toBe(14);
});
