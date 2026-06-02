/**
 * Tests for lib/node/pi/abortable-delay.ts.
 */

import { describe, expect, test, vi } from 'vitest';

import { delay } from '../../../../lib/node/pi/abortable-delay.ts';

describe('delay', () => {
  test('resolves after the timeout when never aborted', async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const promise = delay(1000, ac.signal);
      vi.advanceTimersByTime(1000);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('rejects with aborted when the signal fires before the timeout', async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const promise = delay(1000, ac.signal);
      ac.abort();
      await expect(promise).rejects.toThrow('aborted');
    } finally {
      vi.useRealTimers();
    }
  });

  test('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(delay(1000, ac.signal)).rejects.toThrow('aborted');
  });

  test('clears the timer on abort so it does not resolve afterwards', async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const promise = delay(1000, ac.signal);
      const settled = vi.fn();
      promise.then(settled, settled);
      ac.abort();
      await Promise.resolve();
      vi.advanceTimersByTime(5000);
      // Exactly one settlement (the abort rejection), not a late resolve.
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
