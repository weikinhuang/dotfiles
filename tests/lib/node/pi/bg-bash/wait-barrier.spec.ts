/**
 * Tests for lib/node/pi/bg-bash/wait-barrier.ts.
 */

import { describe, expect, test } from 'vitest';

import { WaitBarrier } from '../../../../../lib/node/pi/bg-bash/wait-barrier.ts';

/** Let every queued microtask run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('WaitBarrier', () => {
  test('settled() is undefined when no wait is in flight', () => {
    const b = new WaitBarrier();
    expect(b.settled('a')).toBeUndefined();
    expect(b.count('a')).toBe(0);
  });

  test('settled() resolves only after every in-flight wait on the id is released', async () => {
    const b = new WaitBarrier();
    const r1 = b.enter('a');
    const r2 = b.enter('a');
    const other = b.enter('b');
    expect(b.count('a')).toBe(2);
    let done = false;
    void b.settled('a')?.then(() => {
      done = true;
    });
    r1();
    await flush();
    expect(done).toBe(false);
    r2();
    await flush();
    expect(done).toBe(true);
    expect(b.count('a')).toBe(0);
    expect(b.count('b')).toBe(1);
    other();
    expect(b.settled('b')).toBeUndefined();
  });

  test('release is idempotent', () => {
    const b = new WaitBarrier();
    const r1 = b.enter('a');
    const r2 = b.enter('a');
    r1();
    r1();
    expect(b.count('a')).toBe(1);
    r2();
    expect(b.count('a')).toBe(0);
  });

  test('a parallel [wait, logs] batch: logs observes the post-wait state', async () => {
    // Model of pi's parallel tool execution: each execute is started in
    // message order through the same async dispatch path, then all run
    // concurrently and results are collected in order.
    const b = new WaitBarrier();
    let jobOutput = '== vitest\n';
    let finishJob!: () => void;
    const jobExited = new Promise<void>((resolve) => {
      finishJob = resolve;
    });

    const actWait = async (): Promise<string> => {
      const release = b.enter('j');
      try {
        await jobExited;
        return 'exited';
      } finally {
        release();
      }
    };
    const actLogs = async (): Promise<string> => {
      await b.settled('j');
      return jobOutput;
    };
    const dispatch = async (fn: () => Promise<string>): Promise<string> => {
      await Promise.resolve(); // pi wrapper layers
      return fn();
    };

    const batch = Promise.all([actWait, actLogs].map((fn) => dispatch(fn)));
    await flush();
    jobOutput += ' Test Files  488 passed\n';
    finishJob();
    const [waitResult, logsResult] = await batch;
    expect(waitResult).toBe('exited');
    expect(logsResult).toBe('== vitest\n Test Files  488 passed\n');
  });
});
