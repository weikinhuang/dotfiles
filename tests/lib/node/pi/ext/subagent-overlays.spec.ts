/**
 * Deterministic render tests for the /agents overlays' viewport windowing
 * (lib/node/pi/ext/subagent-overlays.ts). Model-independent: build synthetic
 * agent lists / running-child lists longer than a short terminal can show and
 * assert the list is windowed within the viewport (preview/detail pinned).
 */

import { expect, test } from 'vitest';

import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';

import { AgentsLoadedOverlay, AgentsRunningOverlay } from '../../../../../lib/node/pi/ext/subagent-overlays.ts';
import type { AgentPreviewSource } from '../../../../../lib/node/pi/subagent/format.ts';

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

const VIEWPORT = (rows: number): number => Math.max(6, rows - 2);

function makeAgents(n: number): AgentPreviewSource[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `agent-${i}`,
    description: `Agent ${i} does a thing that is described in a moderately long sentence for the row.`,
    source: 'global' as const,
    path: `/agents/agent-${i}.md`,
    tools: ['read', 'bash'],
    model: 'inherit' as const,
    maxTurns: 20,
    timeoutMs: 60000,
    isolation: 'shared-cwd' as const,
  }));
}

test('AgentsLoadedOverlay: long agent list stays within the viewport', () => {
  const rows = 22;
  const overlay = new AgentsLoadedOverlay(makeAgents(24), theme, makeTui(rows), noop);
  const lines = overlay.render(120);
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(rows));
  expect(lines.some((l) => l.includes('more'))).toBe(true);
  // Preview block pinned below: the help line is always present.
  expect(lines.some((l) => l.includes('Press Escape to close'))).toBe(true);
});

test('AgentsLoadedOverlay: moving to the last agent scrolls the list down', () => {
  const overlay = new AgentsLoadedOverlay(makeAgents(24), theme, makeTui(22), noop);
  overlay.render(120);
  for (let i = 0; i < 23; i++) overlay.handleInput('\u001b[B'); // down arrow
  const lines = overlay.render(120);
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(22));
  expect(lines.some((l) => l.includes('↑') && l.includes('more'))).toBe(true);
});

test('AgentsLoadedOverlay: short list is not windowed', () => {
  const overlay = new AgentsLoadedOverlay(makeAgents(2), theme, makeTui(40), noop);
  const lines = overlay.render(120);
  expect(lines.some((l) => l.includes('more'))).toBe(false);
});

test('AgentsLoadedOverlay: empty state renders the hint', () => {
  const overlay = new AgentsLoadedOverlay([], theme, makeTui(22), noop);
  const lines = overlay.render(120);
  expect(lines.some((l) => l.includes('No agents loaded'))).toBe(true);
});

// ── running overlay ──────────────────────────────────────────────────────

interface RunningEntry {
  handle: string;
  agent: string;
  task: string;
  snapshot: {
    agent: string;
    state: string;
    turns: number;
    input: number;
    cacheRead: number;
    output: number;
    cost: number;
  };
  startedAt: number;
  lastUpdateMs: number;
  running: boolean;
  sessionFile: string | undefined;
}

function makeEntries(n: number): RunningEntry[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    handle: `sub_${i}`,
    agent: `agent-${i}`,
    task: `Task ${i} that the child sub-agent is working on right now`,
    snapshot: { agent: `agent-${i}`, state: 'running', turns: 3, input: 100, cacheRead: 0, output: 50, cost: 0.01 },
    startedAt: now - i * 1000,
    lastUpdateMs: now - i * 100,
    running: true,
    sessionFile: undefined,
  }));
}

function makeRunning(rows: number, count: number): AgentsRunningOverlay {
  const entries = makeEntries(count);
  return new AgentsRunningOverlay(() => entries as never, new Map(), theme, makeTui(rows), noop);
}

test('AgentsRunningOverlay: many children stay within the viewport', () => {
  const rows = 24;
  const overlay = makeRunning(rows, 16);
  const lines = overlay.render(120);
  expect(lines.length).toBeLessThanOrEqual(VIEWPORT(rows));
  expect(lines.some((l) => l.includes('more'))).toBe(true);
  expect(lines.some((l) => l.includes('Press Escape to close'))).toBe(true);
});

test('AgentsRunningOverlay: empty state renders the hint', () => {
  const overlay = makeRunning(24, 0);
  const lines = overlay.render(120);
  expect(lines.some((l) => l.includes('No background sub-agents running'))).toBe(true);
});
