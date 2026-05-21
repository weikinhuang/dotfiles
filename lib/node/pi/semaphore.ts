/**
 * Minimal async semaphore. `acquire()` resolves only when the caller is
 * allowed to proceed (active count < limit); the caller must pair it
 * with a `release()` inside a `finally`. Waiters are resumed FIFO.
 *
 * The fast path increments `active` before returning; the slow path
 * parks on the queue, and the increment is intentionally skipped in
 * `release()` so the waiter inherits the released slot. Net effect:
 * `active` reflects the number of outstanding `acquire()`s without
 * needing the waiter to re-increment on resumption.
 *
 * Pure module - no pi imports - so it's directly unit-testable.
 */

export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    // Waiter inherits the slot released by the prior holder - no
    // additional `active++` needed because `release()` intentionally
    // skipped its `active--` when a waiter was present.
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active--;
  }
}
