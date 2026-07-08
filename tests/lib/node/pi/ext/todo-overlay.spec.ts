/**
 * Deterministic render tests for the TodoOverlay viewport windowing
 * (lib/node/pi/ext/todo-overlay.ts). Model-independent: constructs the overlay
 * with a synthetic state + fake theme/tui and asserts the rendered line list
 * is bounded to the terminal budget with the right scroll indicators.
 */

import { expect, test } from 'vitest';

import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';

import { TodoOverlay } from '../../../../../lib/node/pi/ext/todo-overlay.ts';
import { type Todo, type TodoState } from '../../../../../lib/node/pi/todo-reducer.ts';

// Fake theme: every color/bold helper just returns the text, so rendered lines
// are plain and length assertions are exact.
const theme = {
  fg: (_token: string, text: string): string => text,
  bold: (text: string): string => text,
} as unknown as Theme;

function makeTui(rows: number): TUI {
  return {
    terminal: { rows, columns: 100 },
    requestRender: (): void => {
      /* no-op */
    },
  } as unknown as TUI;
}

function makeState(n: number): TodoState {
  const todos: Todo[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    text: `Task ${i + 1} - a reasonably long description so the row has real width`,
    status: 'pending' as const,
  }));
  return { todos, nextId: n + 1 };
}

const VIEWPORT = (rows: number): number => Math.max(6, rows - 2);

// onClose is never invoked in these render-only tests.
const noop = (): void => {
  /* no-op */
};

test('TodoOverlay: overflowing list is bounded to the viewport budget', () => {
  const rows = 20;
  const overlay = new TodoOverlay(makeState(16), theme, makeTui(rows), noop);
  const lines = overlay.render(100);
  expect(lines.length).toBe(VIEWPORT(rows));
  // Title header pinned at top, help footer pinned at bottom.
  expect(lines.some((l) => l.includes('Todos'))).toBe(true);
  expect(lines.some((l) => l.includes('Press Escape to close'))).toBe(true);
});

test('TodoOverlay: at top shows a down-indicator and no up-indicator', () => {
  const overlay = new TodoOverlay(makeState(16), theme, makeTui(20), noop);
  const lines = overlay.render(100);
  expect(lines.some((l) => l.includes('↓') && l.includes('more'))).toBe(true);
  expect(lines.some((l) => l.includes('↑') && l.includes('more'))).toBe(false);
});

test('TodoOverlay: G scrolls to the end and flips the indicators', () => {
  const overlay = new TodoOverlay(makeState(16), theme, makeTui(20), noop);
  overlay.render(100); // first render establishes maxScrollTop
  overlay.handleInput('G'); // jump to end
  const lines = overlay.render(100);
  expect(lines.length).toBe(VIEWPORT(20));
  expect(lines.some((l) => l.includes('↑') && l.includes('more'))).toBe(true);
  expect(lines.some((l) => l.includes('↓') && l.includes('more'))).toBe(false);
});

test('TodoOverlay: g returns to the top after scrolling', () => {
  const overlay = new TodoOverlay(makeState(16), theme, makeTui(20), noop);
  overlay.render(100);
  overlay.handleInput('G');
  overlay.render(100);
  overlay.handleInput('g'); // back to top
  const lines = overlay.render(100);
  expect(lines.some((l) => l.includes('↑') && l.includes('more'))).toBe(false);
  expect(lines.some((l) => l.includes('↓') && l.includes('more'))).toBe(true);
});

test('TodoOverlay: short list renders whole with no indicators', () => {
  const overlay = new TodoOverlay(makeState(2), theme, makeTui(30), noop);
  const lines = overlay.render(100);
  expect(lines.some((l) => l.includes('more'))).toBe(false);
  expect(lines.length).toBeLessThan(VIEWPORT(30));
});

test('TodoOverlay: empty state renders the hint, no crash', () => {
  const overlay = new TodoOverlay({ todos: [], nextId: 1 }, theme, makeTui(20), noop);
  const lines = overlay.render(100);
  expect(lines.some((l) => l.includes('No todos yet'))).toBe(true);
});
