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

test('formatWaitResult: timed-out and exited variants', () => {
  const running = job({ id: '7', status: 'running', startedAt: 0 });
  expect(formatWaitResult(running, { timedOut: true, timeoutMs: 500 }, 1000)).toContain('Still running after 500ms: ');
  const exited = job({ id: '7', status: 'exited', exitCode: 0, startedAt: 0, endedAt: 1000 });
  expect(formatWaitResult(exited, { timedOut: false, timeoutMs: 500 }, 2000)).toContain('Exited: ');
});
