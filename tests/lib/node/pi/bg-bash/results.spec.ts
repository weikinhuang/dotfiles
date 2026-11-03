/**
 * Covers the bg-bash tool-result text shapers
 * (lib/node/pi/bg-bash/results.ts) extracted from the extension's
 * `start` / `logs` / `wait` action closures.
 */

import { expect, test } from 'vitest';

import {
  formatLogsHeader,
  formatLogsText,
  formatStartResult,
  formatWaitResult,
} from '../../../../../lib/node/pi/bg-bash/results.ts';
import { type JobSummary } from '../../../../../lib/node/pi/bg-bash-reducer.ts';

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: '3',
    command: 'echo hi',
    cwd: '/tmp',
    status: 'running',
    startedAt: 1000,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTail: '',
    stderrTail: '',
    ...overrides,
  };
}

test('formatStartResult: running job reports id, pid and command', () => {
  expect(formatStartResult(job({ id: '5', pid: 4242, command: 'npm run dev' }))).toBe(
    'Started [5] pid 4242: npm run dev',
  );
});

test('formatStartResult: missing pid falls back to ?', () => {
  expect(formatStartResult(job({ id: '5', pid: undefined }))).toBe('Started [5] pid ?: echo hi');
});

test('formatStartResult: error status reports the spawn error', () => {
  expect(formatStartResult(job({ status: 'error', error: 'ENOENT' }))).toBe('Failed to start: ENOENT');
  expect(formatStartResult(job({ status: 'error', error: undefined }))).toBe('Failed to start: unknown error');
});

test('formatStartResult: appends a warning line when given', () => {
  expect(formatStartResult(job({ id: '5', pid: 1 }), 'Warning: bash-only')).toBe(
    'Started [5] pid 1: echo hi\nWarning: bash-only',
  );
});

test('formatLogsHeader: composes bytes summary; no eviction note by default', () => {
  expect(formatLogsHeader({ id: '3', stream: 'merged', totalBytes: 128, droppedBytes: 0, droppedBefore: false })).toBe(
    '--- [3] merged: 128 bytes total, 0 dropped from memory ---',
  );
});

test('formatLogsHeader: droppedBefore adds the cursor-evicted note', () => {
  expect(formatLogsHeader({ id: '3', stream: 'stdout', totalBytes: 9, droppedBytes: 5, droppedBefore: true })).toBe(
    '--- [3] stdout: 9 bytes total, 5 dropped from memory (your cursor was evicted - fall back to logFile) ---',
  );
});

test('formatLogsHeader: a running job is marked as a partial snapshot; terminal jobs are not', () => {
  const base = { id: '3', stream: 'merged', totalBytes: 10, droppedBytes: 0, droppedBefore: false };
  expect(formatLogsHeader({ ...base, jobStatus: 'running' })).toBe(
    '--- [3] merged: 10 bytes total, 0 dropped from memory (job still running - output so far) ---',
  );
  expect(formatLogsHeader({ ...base, jobStatus: 'exited' })).toBe(
    '--- [3] merged: 10 bytes total, 0 dropped from memory ---',
  );
});

test('formatLogsText: appends content and the full-log note when logFile set', () => {
  expect(
    formatLogsText({
      id: '3',
      stream: 'merged',
      totalBytes: 4,
      droppedBytes: 0,
      droppedBefore: false,
      content: 'body',
      logFile: '/tmp/3.log',
    }),
  ).toBe('--- [3] merged: 4 bytes total, 0 dropped from memory ---\nbody\n--- full log: /tmp/3.log ---');
});

test('formatLogsText: omits the note when there is no logFile', () => {
  expect(
    formatLogsText({
      id: '3',
      stream: 'merged',
      totalBytes: 4,
      droppedBytes: 0,
      droppedBefore: false,
      content: 'body',
    }),
  ).toBe('--- [3] merged: 4 bytes total, 0 dropped from memory ---\nbody');
});

test.each([
  { summary: job({ status: 'exited', exitCode: 0, endedAt: 6000 }), line: '[3] ✓ echo hi - exited 0 after 5s, 0B' },
  { summary: job({ status: 'exited', exitCode: 2, endedAt: 6000 }), line: '[3] ✗ echo hi - exited 2 after 5s, 0B' },
  { summary: job({ status: 'error', error: 'ENOENT', endedAt: 1000 }), line: '[3] ✗ echo hi - error: ENOENT' },
  {
    summary: job({ status: 'signaled', signal: 'SIGTERM', endedAt: 6000 }),
    line: '[3] ✗ echo hi - SIGTERM after 5s, 0B',
  },
  {
    summary: job({ status: 'terminated', endedAt: 6000 }),
    line: '[3] ◌ echo hi - terminated (pi session ended), ran 5s, 0B',
  },
  { summary: job({ status: 'exited', exitCode: 0 }), line: '[3] ✓ echo hi - exited 0 after 0s, 0B' },
])('formatLogsText: stable completed summary $line', ({ summary, line }) => {
  expect(
    formatLogsText({
      id: '3',
      stream: 'merged',
      totalBytes: 4,
      droppedBytes: 0,
      droppedBefore: false,
      content: 'body',
      logFile: '/tmp/3.log',
      jobStatus: summary.status,
      job: summary,
    }),
  ).toBe(`--- [3] merged: 4 bytes total, 0 dropped from memory ---\n${line}\nbody\n--- full log: /tmp/3.log ---`);
});

test.each([job(), job({ status: 'signaled', signal: 'SIGTERM' })])(
  'formatLogsText: $status without an outcome stays partial',
  (summary) => {
    expect(
      formatLogsText({
        id: '3',
        stream: 'merged',
        totalBytes: 4,
        droppedBytes: 0,
        droppedBefore: false,
        content: 'body',
        jobStatus: 'exited',
        job: summary,
      }),
    ).toBe('--- [3] merged: 4 bytes total, 0 dropped from memory (job still running - output so far) ---\nbody');
  },
);

test('formatLogsHeader: status-only signaled jobs are conservatively partial', () => {
  expect(
    formatLogsHeader({
      id: '3',
      stream: 'merged',
      totalBytes: 4,
      droppedBytes: 0,
      droppedBefore: false,
      jobStatus: 'signaled',
    }),
  ).toBe('--- [3] merged: 4 bytes total, 0 dropped from memory (job still running - output so far) ---');
});

test.each([
  job({ status: 'exited', exitCode: 0, endedAt: 6000, outputOpen: true }),
  job({ status: 'exited', exitCode: 1, endedAt: 6000, outputOpen: true }),
  job({ status: 'signaled', signal: 'SIGTERM', endedAt: 6000, outputOpen: true }),
])('formatLogsText: $status with an open output pipe has an outcome but partial output', (summary) => {
  const text = formatLogsText({
    id: '3',
    stream: 'merged',
    totalBytes: 4,
    droppedBytes: 0,
    droppedBefore: false,
    content: 'body',
    jobStatus: summary.status,
    job: summary,
  });

  expect(text).toContain('(job finished - output still partial; output pipe open) ---\n[3]');
  expect(text).toContain('after 5s, 0B (output pipe still held open by a background process)\nbody');
  expect(text).not.toContain('still running');
  expect(text).toContain(summary.exitCode === 0 ? '[3] ✓' : '[3] ✗');
});

test('formatWaitResult: timed-out and exited variants', () => {
  const running = job({ id: '7', status: 'running', startedAt: 0 });
  expect(formatWaitResult(running, { timedOut: true, timeoutMs: 500 }, 1000)).toContain('Still running after 500ms: ');
  const exited = job({ id: '7', status: 'exited', exitCode: 0, startedAt: 0, endedAt: 1000 });
  expect(formatWaitResult(exited, { timedOut: false, timeoutMs: 500 }, 2000)).toContain('Exited: ');
});
