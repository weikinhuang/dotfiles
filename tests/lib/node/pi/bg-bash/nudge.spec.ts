/**
 * Tests for lib/node/pi/bg-bash/nudge.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  BG_BASH_NUDGE_CUSTOM_TYPE,
  formatBgBashNudge,
  isNudgeWorthy,
} from '../../../../../lib/node/pi/bg-bash/nudge.ts';
import { type JobStatus, type JobSummary } from '../../../../../lib/node/pi/bg-bash-reducer.ts';

const START = 1_000_000;

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: '1',
    command: 'echo hi',
    cwd: '/tmp',
    status: 'exited',
    exitCode: 0,
    startedAt: START,
    endedAt: START + 5000,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTail: '',
    stderrTail: '',
    ...overrides,
  };
}

describe('isNudgeWorthy', () => {
  test('nudges on self-terminal states', () => {
    expect(isNudgeWorthy('exited')).toBe(true);
    expect(isNudgeWorthy('error')).toBe(true);
  });

  test('does not nudge on deliberate / non-terminal states', () => {
    for (const s of ['running', 'signaled', 'terminated'] as JobStatus[]) {
      expect(isNudgeWorthy(s)).toBe(false);
    }
  });
});

describe('formatBgBashNudge', () => {
  const now = START + 5000;

  test('single job: one line referencing its id and exit', () => {
    const text = formatBgBashNudge([job({ id: '3', command: 'npm run build', exitCode: 0 })], now);
    expect(text).toContain('Background job [3]');
    expect(text).toContain('exited 0');
    expect(text).toContain('bg_bash logs 3');
    expect(text).not.toContain('\n'); // single-job notice is one line
  });

  test('single job: surfaces a non-zero exit code', () => {
    const text = formatBgBashNudge([job({ id: '4', command: 'npm test', exitCode: 1 })], now);
    expect(text).toContain('exited 1');
  });

  test('multiple jobs: header count plus one indented line per job', () => {
    const text = formatBgBashNudge(
      [job({ id: '3', command: 'npm run build', exitCode: 0 }), job({ id: '5', command: 'npm test', exitCode: 1 })],
      now,
    );
    expect(text).toContain('2 background jobs finished:');
    expect(text).toContain('  [3]');
    expect(text).toContain('  [5]');
    expect(text).toContain('bg_bash logs <id>');
  });

  test('error job renders its message', () => {
    const text = formatBgBashNudge([job({ id: '7', status: 'error', error: 'ENOENT', exitCode: undefined })], now);
    expect(text).toContain('error: ENOENT');
  });
});

describe('BG_BASH_NUDGE_CUSTOM_TYPE', () => {
  test('is distinct from the persistence custom type', () => {
    expect(BG_BASH_NUDGE_CUSTOM_TYPE).toBe('bg-bash-nudge');
  });
});
