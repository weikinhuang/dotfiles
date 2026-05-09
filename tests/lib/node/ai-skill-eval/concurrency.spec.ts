// Tests for lib/node/ai-skill-eval/concurrency.ts.
//
// The pool is I/O-focused so these tests use fake timers to advance virtual
// time and assert on peak concurrency, completion ordering, and error
// propagation without waiting on real wall-clock delays.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runPool } from '../../../../lib/node/ai-skill-eval/concurrency.ts';

describe('runPool', () => {
  test('returns results in input order even when workers finish out of order', async () => {
    const items = [10, 50, 20, 40, 30];
    const results = await runPool(items, { limit: 3 }, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });

    expect(results).toEqual([20, 100, 40, 80, 60]);
  });

  test('empty input returns [] and never invokes the worker', async () => {
    const worker = vi.fn(() => Promise.resolve(1));
    const results = await runPool([], { limit: 4 }, worker);

    expect(results).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  test('limit=1 serialises work (peak concurrency never exceeds 1)', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [1, 2, 3, 4];

    const results = await runPool(items, { limit: 1 }, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return i;
    });

    expect(results).toEqual(items);
    expect(peak).toBe(1);
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test('limit=2 with 4×100ms work completes in ~200ms (two waves)', async () => {
      let inFlight = 0;
      let peak = 0;
      const items = [0, 1, 2, 3];

      const pending = runPool(items, { limit: 2 }, async (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 100));
        inFlight -= 1;
        return i;
      });

      // First wave: 2 workers start immediately.
      await vi.advanceTimersByTimeAsync(100);
      // Second wave finishes.
      await vi.advanceTimersByTimeAsync(100);
      const results = await pending;

      expect(results).toEqual(items);
      expect(peak).toBe(2);
    });

    test('limit larger than items is clamped to item count (no idle slot)', async () => {
      let inFlight = 0;
      let peak = 0;
      const items = [0, 1, 2];

      const pending = runPool(items, { limit: 10 }, (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise<number>((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve(i);
          }, 10);
        });
      });

      await vi.advanceTimersByTimeAsync(10);
      await pending;

      expect(peak).toBe(3);
    });
  });

  test('rejected worker surfaces out of runPool', async () => {
    const boom = new Error('boom');

    await expect(
      runPool([1, 2, 3], { limit: 2 }, (n) => (n === 2 ? Promise.reject(boom) : Promise.resolve(n))),
    ).rejects.toBe(boom);
  });
});
