/**
 * Tests for lib/node/pi/semaphore.ts.
 */

import { expect, test } from 'vitest';

import { Semaphore } from '../../../../lib/node/pi/semaphore.ts';

test('Semaphore: respects the concurrency limit', async () => {
  const sem = new Semaphore(2);
  const inFlight: number[] = [];
  let peak = 0;
  let active = 0;

  const work = async (id: number): Promise<void> => {
    await sem.acquire();
    try {
      active++;
      peak = Math.max(peak, active);
      inFlight.push(id);
      await new Promise((r) => setTimeout(r, 5));
    } finally {
      active--;
      sem.release();
    }
  };

  await Promise.all([work(1), work(2), work(3), work(4), work(5)]);

  expect(peak).toBe(2);
  expect(inFlight.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
});

test('Semaphore: resumes waiters in FIFO order', async () => {
  const sem = new Semaphore(1);
  const order: number[] = [];

  await sem.acquire(); // active = 1, holder.

  const p1 = (async () => {
    await sem.acquire();
    order.push(1);
    sem.release();
  })();
  const p2 = (async () => {
    await sem.acquire();
    order.push(2);
    sem.release();
  })();
  const p3 = (async () => {
    await sem.acquire();
    order.push(3);
    sem.release();
  })();

  // Yield so all three enqueue before we release.
  await new Promise((r) => setTimeout(r, 0));
  sem.release();

  await Promise.all([p1, p2, p3]);
  expect(order).toEqual([1, 2, 3]);
});

test('Semaphore: limit of 1 serializes work', async () => {
  const sem = new Semaphore(1);
  let active = 0;
  let peak = 0;

  const work = async (): Promise<void> => {
    await sem.acquire();
    try {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
    } finally {
      active--;
      sem.release();
    }
  };

  await Promise.all([work(), work(), work()]);
  expect(peak).toBe(1);
});
