/**
 * Tests for lib/node/pi/bg-bash-prompt.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { formatBackgroundJobs, formatRegistryText } from '../../../../lib/node/pi/bg-bash-prompt.ts';
import { type BgBashState, type JobSummary } from '../../../../lib/node/pi/bg-bash-reducer.ts';

function mkJob(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'abc12345',
    command: 'echo hi',
    cwd: '/tmp',
    pid: 1000,
    status: 'running',
    startedAt: 1_000_000,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTail: '',
    stderrTail: '',
    ...overrides,
  };
}

function mkState(jobs: JobSummary[]): BgBashState {
  return { jobs, nextId: jobs.length + 1 };
}

const NOW = 1_000_050_000; // deterministic "now"

// ──────────────────────────────────────────────────────────────────────
// formatBackgroundJobs
// ──────────────────────────────────────────────────────────────────────

test('returns null when there are no jobs at all', () => {
  expect(formatBackgroundJobs(mkState([]), { now: NOW })).toBe(null);
});

test('renders only running jobs when nothing is terminal', () => {
  const out = formatBackgroundJobs(mkState([mkJob({ id: 'r1', command: 'npm test', status: 'running' })]), {
    now: NOW,
  })!;

  expect(out).toMatch(/## Background Jobs/);
  expect(out).toMatch(/\*\*Running\*\*/);
  expect(out).toMatch(/\[r1\]/);
  expect(out).toMatch(/npm test/);
  // No "Recent" section when there are no terminal jobs.
  expect(out.includes('**Recent**')).toBe(false);
});

test('renders only recent jobs when nothing is running', () => {
  const out = formatBackgroundJobs(
    mkState([mkJob({ id: 'r1', command: 'make', status: 'exited', exitCode: 0, endedAt: 1_000_005_000 })]),
    { now: NOW },
  )!;

  expect(out).toMatch(/\*\*Running\*\*/);
  expect(out).toMatch(/\(none\)/);
  expect(out).toMatch(/\*\*Recent\*\*/);
  expect(out).toMatch(/\[r1\]/);
  expect(out).toMatch(/exited 0/);
});

test('caps the recent list at recentCap', () => {
  const state = mkState([
    mkJob({ id: 'a', command: 'a', status: 'exited', exitCode: 0, endedAt: 1_000_001_000 }),
    mkJob({ id: 'b', command: 'b', status: 'exited', exitCode: 0, endedAt: 1_000_002_000 }),
    mkJob({ id: 'c', command: 'c', status: 'exited', exitCode: 0, endedAt: 1_000_003_000 }),
    mkJob({ id: 'd', command: 'd', status: 'exited', exitCode: 0, endedAt: 1_000_004_000 }),
  ]);
  const out = formatBackgroundJobs(state, { now: NOW, recentCap: 2 })!;

  // Newest two only: d and c.
  expect(out).toMatch(/\[d\]/);
  expect(out).toMatch(/\[c\]/);
  expect(out.includes('[a]')).toBe(false);
  expect(out.includes('[b]')).toBe(false);
});

test('recentCap=0 hides the Recent section entirely when there is running work', () => {
  const state = mkState([
    mkJob({ id: 'r1', status: 'running' }),
    mkJob({ id: 'x', status: 'exited', exitCode: 0, endedAt: 1_000_001_000 }),
  ]);
  const out = formatBackgroundJobs(state, { now: NOW, recentCap: 0 })!;

  expect(out).toMatch(/\[r1\]/);
  expect(out.includes('[x]')).toBe(false);
  // With an empty recent list we still render the Running section
  // but the "Recent" header is omitted (no terminal rows).
  expect(out.includes('**Recent**')).toBe(false);
});

test('soft cap truncates recent jobs and emits the list-trailer', () => {
  const jobs: JobSummary[] = [];
  // 20 terminal jobs, each with a long command to quickly blow through
  // a tight cap.
  for (let i = 0; i < 20; i++) {
    jobs.push(
      mkJob({
        id: `j${i}`,
        command: 'a'.repeat(40),
        status: 'exited',
        exitCode: 0,
        startedAt: 1_000_000,
        endedAt: 1_000_000 + i * 1000,
      }),
    );
  }
  const out = formatBackgroundJobs(mkState(jobs), { now: NOW, recentCap: 20, maxChars: 400 })!;

  expect(out).toMatch(/not shown — call `bg_bash` with action `list`/);
  // Tool guidance trailer is replaced when truncated.
  expect(out.includes('Use `bg_bash`')).toBe(false);
});

test('untruncated output includes the tool-guidance trailer', () => {
  const out = formatBackgroundJobs(mkState([mkJob({ id: 'r1', status: 'running' })]), { now: NOW })!;

  expect(out).toMatch(/Use `bg_bash`/);
});

// ──────────────────────────────────────────────────────────────────────
// formatRegistryText
// ──────────────────────────────────────────────────────────────────────

test('formatRegistryText: empty and populated', () => {
  expect(formatRegistryText(mkState([]), NOW)).toBe('(no background jobs)');

  const out = formatRegistryText(
    mkState([
      mkJob({ id: 'r1', status: 'running' }),
      mkJob({ id: 'x', status: 'exited', exitCode: 0, endedAt: 1_000_005_000 }),
    ]),
    NOW,
  );

  expect(out).toMatch(/\[r1\]/);
  expect(out).toMatch(/\[x\]/);
});
