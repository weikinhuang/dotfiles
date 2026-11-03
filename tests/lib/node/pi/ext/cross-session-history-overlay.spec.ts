/**
 * Deterministic render tests for the ReverseSearchOverlay viewport windowing
 * (lib/node/pi/ext/cross-session-history-overlay.ts). Model-independent: builds
 * a search overlay with more prompts than a short terminal can show and asserts
 * the rendered box stays within the viewport, shrinking the visible-row budget.
 */

import { expect, test } from 'vitest';

import type { Theme } from '@earendil-works/pi-coding-agent';
import { type TUI, visibleWidth } from '@earendil-works/pi-tui';

import { ReverseSearchOverlay } from '../../../../../lib/node/pi/ext/cross-session-history-overlay.ts';

const theme = { fg: (_t: string, s: string): string => s, bold: (s: string): string => s } as unknown as Theme;

function makeTui(rows: number | (() => number)): TUI {
  return {
    terminal: {
      get rows(): number {
        return typeof rows === 'function' ? rows() : rows;
      },
      columns: 100,
    },
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
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(40));
  expect(lines.filter((line) => /prompt number \d+ with some text/u.test(line)).length).toBeGreaterThanOrEqual(10);
  expect(lines.some((line) => line.includes('Preview'))).toBe(true);
});

test('ReverseSearchOverlay: short terminal shows fewer rows than a tall one', () => {
  const short = new ReverseSearchOverlay(theme, prompts(50), makeTui(12)).render(100);
  const tall = new ReverseSearchOverlay(theme, prompts(50), makeTui(40)).render(100);
  expect(short.length).toBeLessThan(tall.length);
});

test('ReverseSearchOverlay: no tui falls back to the fixed cap without crashing', () => {
  const overlay = new ReverseSearchOverlay(theme, prompts(50));
  const lines = overlay.render(100);
  expect(lines.length).toBeGreaterThan(14);
  expect(lines.some((line) => line.includes('Preview'))).toBe(true);
});

function previewText(lines: string[]): string {
  const start = lines.findIndex((line) => line.includes('Preview'));
  return lines.slice(start + 1, -2).join('\n');
}

test('ReverseSearchOverlay: full-text search shows a later matching line and accepts untouched text', () => {
  const prompt = 'fix the regression\nlook in database.ts\nkeep the API stable';
  const overlay = new ReverseSearchOverlay(theme, [{ prompt, isOpener: true }], makeTui(40));
  overlay.handleInput('database');
  const lines = overlay.render(100);
  expect(lines.some((line) => line.includes('[opener] L2 look in database.ts'))).toBe(true);
  expect(previewText(lines)).toContain('look in database.ts');
  let accepted: string | undefined;
  overlay.onAccept = (value) => {
    accepted = value;
  };
  overlay.handleInput('\r');
  expect(accepted).toBe(prompt);
});

test('ReverseSearchOverlay: continuation filter is reversible and never hides an opener', () => {
  const overlay = new ReverseSearchOverlay(
    theme,
    [
      { prompt: 'please continue', isOpener: false },
      { prompt: 'continue', isOpener: true },
      { prompt: 'yes', isOpener: false },
    ],
    makeTui(40),
  );
  let lines = overlay.render(100);
  expect(lines.join('\n')).toContain('1 continuation hidden');
  expect(lines.join('\n')).not.toContain('please continue');
  expect(lines.join('\n')).toContain('[opener] continue');
  overlay.handleInput('\x0f');
  lines = overlay.render(100);
  expect(lines.join('\n')).toContain('please continue');
  expect(lines.join('\n')).toContain('show all');
  overlay.handleInput('\x0f');
  expect(overlay.render(100).join('\n')).not.toContain('please continue');
});

test('ReverseSearchOverlay: preview scrolling is independent of result selection', () => {
  const prompt = Array.from({ length: 25 }, (_, i) => `detail ${i}`).join('\n');
  const overlay = new ReverseSearchOverlay(theme, [prompt, 'second prompt'], makeTui(40));
  const before = previewText(overlay.render(100));
  overlay.handleInput('\t');
  overlay.handleInput('\x1b[6~');
  const after = previewText(overlay.render(100));
  expect(after).not.toBe(before);
  expect(after).toContain('detail 7');
  let accepted: string | undefined;
  overlay.onAccept = (value) => {
    accepted = value;
  };
  overlay.handleInput('\r');
  expect(accepted).toBe(prompt);
});

test('ReverseSearchOverlay: changing selection resets preview scroll and ctrl+r still selects', () => {
  const first = Array.from({ length: 25 }, (_, i) => `first ${i}`).join('\n');
  const second = Array.from({ length: 25 }, (_, i) => `second ${i}`).join('\n');
  const overlay = new ReverseSearchOverlay(theme, [first, second], makeTui(40));
  overlay.render(100);
  overlay.handleInput('\t');
  overlay.handleInput('\x1b[6~');
  overlay.render(100);
  overlay.handleInput('\x12');
  expect(previewText(overlay.render(100))).toContain('second 0');
  overlay.handleInput('\t');
  overlay.handleInput('\x1b[A');
  expect(previewText(overlay.render(100))).toContain('first 0');
});

test('ReverseSearchOverlay: short terminals can switch from results to an opener preview', () => {
  const overlay = new ReverseSearchOverlay(theme, [{ prompt: 'first\nsecond\nthird', isOpener: true }], makeTui(10));
  expect(overlay.render(70).join('\n')).toContain('[opener]');
  overlay.handleInput('\t');
  const lines = overlay.render(70);
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(10));
  expect(lines.join('\n')).toContain('session opener');
  expect(lines.join('\n')).toContain('second');
});

test('ReverseSearchOverlay: late-column matches remain visible with wide Unicode text', () => {
  const prompt = `${'界🌏'.repeat(50)}needle at the end`;
  const overlay = new ReverseSearchOverlay(theme, [prompt], makeTui(40));
  overlay.handleInput('needle');
  const lines = overlay.render(55);
  expect(lines.find((line) => line.startsWith('> '))).toContain('needle');
  expect(lines.join('\n')).not.toContain('\uFFFD');
  expect(lines.every((line) => visibleWidth(line) <= 55)).toBe(true);
});

test('ReverseSearchOverlay: resizing rewraps preview and keeps the selected result', () => {
  let rows = 40;
  const tui = makeTui(() => rows);
  const overlay = new ReverseSearchOverlay(theme, ['first', 'second '.repeat(30)], tui);
  overlay.handleInput('\x1b[B');
  const wide = overlay.render(100);
  rows = 10;
  const narrow = overlay.render(30);
  expect(narrow.length).toBeLessThan(wide.length);
  expect(narrow.some((line) => line.startsWith('> second'))).toBe(true);
  expect(narrow.every((line) => visibleWidth(line) <= 30)).toBe(true);
});

test.each([1, 2, 3, 4, 5, 6, 7, 8])('ReverseSearchOverlay: fits a %s-row terminal', (rows) => {
  const overlay = new ReverseSearchOverlay(theme, prompts(50), makeTui(rows));
  expect(overlay.render(25).length).toBeLessThanOrEqual(Math.max(1, rows - 2));
  overlay.handleInput('\t');
  expect(overlay.render(25).length).toBeLessThanOrEqual(Math.max(1, rows - 2));
});

test.each(['\x1b', '\x03'])('ReverseSearchOverlay: cancellation never inserts a prompt (%s)', (key) => {
  const overlay = new ReverseSearchOverlay(theme, ['first'], makeTui(40));
  let accepted = false;
  let cancelled = false;
  overlay.onAccept = () => {
    accepted = true;
  };
  overlay.onCancel = () => {
    cancelled = true;
  };
  overlay.handleInput(key);
  expect(accepted).toBe(false);
  expect(cancelled).toBe(true);
});
