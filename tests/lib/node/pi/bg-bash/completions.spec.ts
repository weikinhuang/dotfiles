import { describe, expect, test } from 'vitest';

import { deliveredTerminalJobs, PendingCompletions } from '../../../../../lib/node/pi/bg-bash/completions.ts';
import { formatJobLine } from '../../../../../lib/node/pi/bg-bash-format.ts';
import type { BgBashState, JobSummary } from '../../../../../lib/node/pi/bg-bash-reducer.ts';

function job(patch: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'one',
    command: 'test',
    cwd: '/tmp',
    status: 'exited',
    exitCode: 0,
    startedAt: 1000,
    endedAt: 2000,
    stdoutBytes: 10,
    stderrBytes: 0,
    stdoutTail: 'done',
    stderrTail: '',
    nudge: true,
    ...patch,
  };
}
function state(...jobs: JobSummary[]): BgBashState {
  return { jobs, nextId: 1 };
}

describe('PendingCompletions', () => {
  test('deduplicates identities and resolves the latest output snapshot at delivery', () => {
    const pending = new PendingCompletions();
    const first = job();
    pending.add(first);
    pending.add(first);
    const current = job({ stdoutBytes: 100 });
    expect(pending.select(state(current), new Set(), () => false)).toEqual([current]);
    expect(pending.size).toBe(1);
    expect(first.stdoutBytes).toBe(10);
  });
  test('waiting defers instead of forgetting an unacknowledged failure', () => {
    const pending = new PendingCompletions();
    const failed = job({ exitCode: 1 });
    pending.add(failed);
    expect(pending.select(state(failed), new Set(), () => true)).toEqual([]);
    expect(pending.size).toBe(1);
    expect(pending.select(state(failed), new Set(), () => false)).toEqual([failed]);
    pending.forget([failed.id]);
    expect(pending.size).toBe(0);
  });
  test('drops acknowledged, removed, disabled and replacement-runtime jobs only', () => {
    const pending = new PendingCompletions();
    for (const id of ['ack', 'removed', 'disabled', 'reused', 'unseen']) pending.add(job({ id, exitCode: 1 }));
    const unseen = job({ id: 'unseen', exitCode: 1 });
    expect(
      pending.select(
        state(
          job({ id: 'ack' }),
          job({ id: 'disabled', nudge: false }),
          job({ id: 'reused', startedAt: 9000 }),
          unseen,
        ),
        new Set(['ack']),
        () => false,
      ),
    ).toEqual([unseen]);
    expect(pending.size).toBe(1);
    pending.clear();
    expect(pending.size).toBe(0);
  });
  test('never queues running, deliberate signals or opt-out jobs', () => {
    const pending = new PendingCompletions();
    for (const value of [job({ status: 'running' }), job({ status: 'signaled' }), job({ nudge: false })]) {
      pending.add(value);
    }
    expect(pending.size).toBe(0);
  });
});

describe('deliveredTerminalJobs', () => {
  test('uses the immutable delivered snapshot even if late output changed current byte counts', () => {
    const delivered = job({ outputOpen: true });
    const current = job({ stdoutBytes: 500, outputOpen: false });
    const text = formatJobLine(delivered, 2000);
    expect(deliveredTerminalJobs(text, state(delivered), state(current))).toEqual(['one']);
    expect(deliveredTerminalJobs(text, { jobs: [delivered] }, state(current))).toEqual(['one']);
  });
  test('never acknowledges hidden registry metadata or running output', () => {
    const completed = job();
    expect(deliveredTerminalJobs('Started [one]', state(completed), state(completed))).toEqual([]);
    const running = job({ status: 'running', endedAt: undefined });
    expect(deliveredTerminalJobs(formatJobLine(running, 2000), state(running), state(completed))).toEqual([]);
  });
  test('falls back to current canonical lines for reminder captures and malformed details', () => {
    const completed = job({ exitCode: 1 });
    expect(deliveredTerminalJobs(formatJobLine(completed, 2000), undefined, state(completed))).toEqual(['one']);
    expect(deliveredTerminalJobs('unrelated', { jobs: ['bad'] }, state(completed))).toEqual([]);
  });
});
