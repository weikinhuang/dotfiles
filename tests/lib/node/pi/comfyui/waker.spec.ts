/**
 * Tests for lib/node/pi/comfyui/waker.ts.
 *
 * Uses fake timers so the "resolves on the timeout" path is deterministic
 * without a real wait; the wake / latch / abort paths resolve or reject
 * without advancing the clock.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createWaker } from '../../../../../lib/node/pi/comfyui/waker.ts';

const liveSignal = (): AbortSignal => new AbortController().signal;

describe('createWaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('sleep resolves after the timeout when never woken', async () => {
    const waker = createWaker();
    const p = waker.sleep(1000, liveSignal());
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBeUndefined();
  });

  test('wake resolves an in-flight sleep early', async () => {
    const waker = createWaker();
    const p = waker.sleep(1000, liveSignal());
    waker.wake();
    await expect(p).resolves.toBeUndefined();
  });

  test('a wake before sleep is latched and consumed by the next sleep', async () => {
    const waker = createWaker();
    waker.wake();
    await expect(waker.sleep(1000, liveSignal())).resolves.toBeUndefined();
    // Latch is one-shot: the following sleep waits for its timer again.
    const p = waker.sleep(1000, liveSignal());
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBeUndefined();
  });

  test('rejects when the signal is already aborted', async () => {
    const waker = createWaker();
    const ac = new AbortController();
    ac.abort();
    await expect(waker.sleep(1000, ac.signal)).rejects.toThrow('aborted');
  });

  test('rejects when the signal aborts mid-sleep', async () => {
    const waker = createWaker();
    const ac = new AbortController();
    const p = waker.sleep(1000, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow('aborted');
  });
});
