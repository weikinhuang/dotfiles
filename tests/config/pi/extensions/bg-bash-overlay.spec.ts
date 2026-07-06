/**
 * Deterministic render tests for the BgBashOverlay viewport windowing
 * (config/pi/extensions/bg-bash.ts). Model-independent: builds a synthetic
 * state with more jobs than a short terminal can show and asserts the job list
 * is windowed within the viewport (with the log-tail block pinned below).
 */

import { expect, test } from 'vitest';

import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';

import { BgBashOverlay } from '../../../../config/pi/extensions/bg-bash.ts';
import type { BgBashState, JobSummary } from '../../../../lib/node/pi/bg-bash-reducer.ts';

const theme = { fg: (_t: string, s: string): string => s, bold: (s: string): string => s } as unknown as Theme;

function makeTui(rows: number): TUI {
  return {
    terminal: { rows, columns: 120 },
    requestRender: (): void => {
      /* no-op */
    },
  } as unknown as TUI;
}

const noop = (): void => {
  /* no-op */
};

function makeState(n: number): BgBashState {
  const jobs: JobSummary[] = Array.from({ length: n }, (_, i) => ({
    id: `job${String(i).padStart(2, '0')}`,
    command: `sleep ${i} && echo task-${i}`,
    cwd: '/tmp',
    status: 'running',
    startedAt: Date.now() - i * 1000,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTail: '',
    stderrTail: '',
  }));
  return { jobs, nextId: n + 1 };
}

function makeOverlay(rows: number, jobCount: number): BgBashOverlay {
  const state = makeState(jobCount);
  return new BgBashOverlay(
    {
      getState: () => state,
      getLive: () => undefined,
      onSignal: noop,
      onRemove: noop,
      onClearTerminal: noop,
    },
    theme,
    makeTui(rows),
    noop,
  );
}

const VIEWPORT = (rows: number): number => Math.max(6, rows - 2);

test('BgBashOverlay: many jobs stay within the viewport (job list windowed)', () => {
  const rows = 24;
  const overlay = makeOverlay(rows, 20);
  const lines = overlay.render(120);
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(rows));
  // Job list scrolls: a "more" indicator appears.
  expect(lines.some((l) => l.includes('more'))).toBe(true);
  // Lower block stays pinned: the help line is always present.
  expect(lines.some((l) => l.includes('Press Escape to close'))).toBe(true);
});

test('BgBashOverlay: at top there is no up-indicator, but a down-indicator', () => {
  const overlay = makeOverlay(24, 20);
  const lines = overlay.render(120);
  expect(lines.some((l) => l.includes('↑') && l.includes('more'))).toBe(false);
  expect(lines.some((l) => l.includes('↓') && l.includes('more'))).toBe(true);
});

test('BgBashOverlay: moving selection to the last job scrolls the list down', () => {
  const overlay = makeOverlay(24, 20);
  overlay.render(120); // establish window
  for (let i = 0; i < 19; i++) overlay.handleInput('[B'); // down arrow
  const lines = overlay.render(120);
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(24));
  expect(lines.some((l) => l.includes('↑') && l.includes('more'))).toBe(true);
});

test('BgBashOverlay: a short job list is not windowed', () => {
  const overlay = makeOverlay(40, 2);
  const lines = overlay.render(120);
  expect(lines.some((l) => l.includes('↑') && l.includes('more'))).toBe(false);
  expect(lines.some((l) => l.includes('↓') && l.includes('more'))).toBe(false);
});

test('BgBashOverlay: empty state renders the hint, no crash', () => {
  const overlay = makeOverlay(24, 0);
  const lines = overlay.render(120);
  expect(lines.some((l) => l.includes('no background jobs'))).toBe(true);
});
