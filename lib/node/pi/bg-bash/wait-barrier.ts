/**
 * In-flight `wait` bookkeeping for bg_bash.
 *
 * pi runs the tool calls of one assistant message in parallel: every call
 * is prepared first, then all `execute()`s start in message order and run
 * concurrently, and the results are appended in message order. A batch
 * like `[wait <id>, logs <id>]` (or `[wait, status]`) therefore ran `logs`
 * immediately - a snapshot of a still-running job - while its result was
 * shown AFTER the `wait` result reporting the exit. That looked like lost
 * output (`exited 0 ..., 356B` followed by `logs: 10 bytes total`).
 *
 * A `wait` registers here synchronously, before its first `await`, so any
 * sibling `logs` / `status` on the same job (started later in the same
 * batch through the identical dispatch path) can `await settled(id)` and
 * observe the post-wait state, matching the order the model wrote.
 *
 * The same counts drive completion-nudge suppression: a job that exits
 * while a `wait` on it is in flight reports the exit inline instead.
 *
 * No pi imports - unit-tested under vitest.
 */

export class WaitBarrier {
  private readonly pending = new Map<string, Set<Promise<void>>>();

  /**
   * Register an in-flight wait on `id`. Call synchronously (before any
   * `await`) and invoke the returned release function in a `finally`.
   * Releasing twice is a no-op.
   */
  enter(id: string): () => void {
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    let set = this.pending.get(id);
    if (!set) {
      set = new Set();
      this.pending.set(id, set);
    }
    set.add(done);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.pending.get(id);
      cur?.delete(done);
      if (cur?.size === 0) this.pending.delete(id);
      release();
    };
  }

  /** Number of waits on `id` currently in flight. */
  count(id: string): number {
    return this.pending.get(id)?.size ?? 0;
  }

  /**
   * Promise that resolves once every wait on `id` in flight right now has
   * returned, or `undefined` when there is none (callers stay synchronous).
   */
  settled(id: string): Promise<void> | undefined {
    const set = this.pending.get(id);
    if (!set || set.size === 0) return undefined;
    return Promise.all(set).then(() => undefined);
  }
}
