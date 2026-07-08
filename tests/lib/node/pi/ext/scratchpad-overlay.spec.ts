/**
 * Deterministic render/navigation tests for the ScratchpadOverlay
 * (lib/node/pi/ext/scratchpad-overlay.ts). Model-independent: constructs the
 * overlay with a synthetic note set + fake theme/tui and asserts the rendered
 * line list is bounded to the terminal budget, the scroll indicators track the
 * viewport, selection movement is reflected in the row markers, and a single
 * tall note scrolls in place instead of overflowing.
 */

import { expect, test } from 'vitest';

import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';

import { ScratchpadOverlay, type ScratchpadOverlayDeps } from '../../../../../lib/node/pi/ext/scratchpad-overlay.ts';
import { type ScratchNote, type ScratchpadState } from '../../../../../lib/node/pi/scratchpad-reducer.ts';

// Fake theme: every color/bold helper returns the text unchanged so rendered
// lines are plain and length assertions are exact.
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

/** Read-only deps: a fixed state and no-op mutators (these tests never edit). */
function depsFor(state: ScratchpadState): ScratchpadOverlayDeps {
  const noop = (): void => {
    /* no-op */
  };
  return {
    getState: () => state,
    remove: noop,
    updateBody: noop,
    updateHeading: noop,
    append: () => undefined,
  };
}

function makeState(n: number): ScratchpadState {
  const notes: ScratchNote[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    body: `Note ${i + 1} - a reasonably long body so the row occupies real width in the list`,
  }));
  return { notes, nextId: n + 1 };
}

const VIEWPORT = (rows: number): number => Math.max(6, rows - 2);

const noop = (): void => {
  /* no-op */
};

test('ScratchpadOverlay: overflowing list is bounded to the viewport budget', () => {
  const rows = 20;
  const overlay = new ScratchpadOverlay(depsFor(makeState(24)), theme, makeTui(rows), undefined, noop);
  const lines = overlay.render(100);
  expect(lines.length).toBe(VIEWPORT(rows));
  // Pinned header rule + footer hint frame the scroll region.
  expect(lines.some((l) => l.includes('Scratchpad'))).toBe(true);
  expect(lines.some((l) => l.includes('Esc close'))).toBe(true);
});

test('ScratchpadOverlay: at top shows a down-indicator and no up-indicator', () => {
  const overlay = new ScratchpadOverlay(depsFor(makeState(24)), theme, makeTui(20), undefined, noop);
  const lines = overlay.render(100);
  expect(lines.some((l) => l.includes('↓') && l.includes('more'))).toBe(true);
  expect(lines.some((l) => l.includes('↑') && l.includes('more'))).toBe(false);
});

test('ScratchpadOverlay: G scrolls to the end and flips the indicators', () => {
  const overlay = new ScratchpadOverlay(depsFor(makeState(24)), theme, makeTui(20), undefined, noop);
  overlay.render(100); // establish window state
  overlay.handleInput('G'); // jump to the last note
  const lines = overlay.render(100);
  expect(lines.length).toBe(VIEWPORT(20));
  expect(lines.some((l) => l.includes('↑') && l.includes('more'))).toBe(true);
  expect(lines.some((l) => l.includes('↓') && l.includes('more'))).toBe(false);
});

test('ScratchpadOverlay: g returns to the top after scrolling', () => {
  const overlay = new ScratchpadOverlay(depsFor(makeState(24)), theme, makeTui(20), undefined, noop);
  overlay.render(100);
  overlay.handleInput('G');
  overlay.render(100);
  overlay.handleInput('g'); // back to the top
  const lines = overlay.render(100);
  expect(lines.some((l) => l.includes('↑') && l.includes('more'))).toBe(false);
  expect(lines.some((l) => l.includes('↓') && l.includes('more'))).toBe(true);
});

test('ScratchpadOverlay: short list renders whole with no indicators', () => {
  const overlay = new ScratchpadOverlay(depsFor(makeState(2)), theme, makeTui(30), undefined, noop);
  const lines = overlay.render(100);
  expect(lines.some((l) => l.includes('more'))).toBe(false);
  expect(lines.length).toBeLessThan(VIEWPORT(30));
});

test('ScratchpadOverlay: empty state renders the hint, no crash', () => {
  const overlay = new ScratchpadOverlay(depsFor({ notes: [], nextId: 1 }), theme, makeTui(20), undefined, noop);
  const lines = overlay.render(100);
  expect(lines.some((l) => l.includes('Scratchpad is empty'))).toBe(true);
});

test('ScratchpadOverlay: renders grouped section labels and marks the selection', () => {
  const state: ScratchpadState = {
    notes: [
      { id: 1, heading: 'decisions', body: 'chose approach B' },
      { id: 2, heading: 'decisions', body: 'store secrets in env' },
      { id: 3, body: 'run ./dev/test' },
    ],
    nextId: 4,
  };
  const overlay = new ScratchpadOverlay(depsFor(state), theme, makeTui(30), undefined, noop);
  const lines = overlay.render(100);
  // Heading group label + the default "Notes" label for the headless note.
  expect(lines.some((l) => l.includes('decisions'))).toBe(true);
  expect(lines.some((l) => l.includes('Notes'))).toBe(true);
  // First note selected by default: its row carries the `>` marker on #1.
  expect(lines.some((l) => l.includes('> #1'))).toBe(true);
  expect(lines.some((l) => l.includes('> #2'))).toBe(false);
});

test('ScratchpadOverlay: j moves the selection marker to the next note', () => {
  const state: ScratchpadState = {
    notes: [
      { id: 1, body: 'first' },
      { id: 2, body: 'second' },
      { id: 3, body: 'third' },
    ],
    nextId: 4,
  };
  const overlay = new ScratchpadOverlay(depsFor(state), theme, makeTui(30), undefined, noop);
  overlay.render(100);
  overlay.handleInput('j'); // down one note
  const lines = overlay.render(100);
  expect(lines.some((l) => l.includes('> #2'))).toBe(true);
  expect(lines.some((l) => l.includes('> #1'))).toBe(false);
});

test('ScratchpadOverlay: a single tall note scrolls in place instead of overflowing', () => {
  const tallBody = Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ');
  const state: ScratchpadState = { notes: [{ id: 1, body: tallBody }], nextId: 2 };
  const overlay = new ScratchpadOverlay(depsFor(state), theme, makeTui(14), undefined, noop);
  const top = overlay.render(100);
  // Bounded to the viewport, showing only the head of the note.
  expect(top.length).toBe(VIEWPORT(14));
  expect(top.some((l) => l.includes('↓') && l.includes('more'))).toBe(true);
  expect(top.some((l) => l.includes('↑') && l.includes('more'))).toBe(false);
  // Down scrolls within the note (selection can't move - there's only one).
  for (let i = 0; i < 40; i++) overlay.handleInput('j');
  const bottom = overlay.render(100);
  expect(bottom.length).toBe(VIEWPORT(14));
  expect(bottom.some((l) => l.includes('↑') && l.includes('more'))).toBe(true);
  expect(bottom.some((l) => l.includes('↓') && l.includes('more'))).toBe(false);
});
