// Tiny promise-based concurrency limiter for ai-skill-eval.
//
// `runPool` walks a list of work items and invokes `worker` for each one,
// keeping at most `limit` invocations in flight concurrently. Results are
// returned in input order regardless of completion order. There's no
// worker_threads / cluster here - the work items are I/O-bound driver calls
// and we only need async concurrency, not parallel CPU.
//
// A rejected worker propagates out of `runPool` immediately. In-flight
// siblings are NOT cancelled (Node has no Promise cancellation primitive);
// they settle on their own but their results are discarded.
// SPDX-License-Identifier: MIT

export interface RunPoolOptions {
  /** Maximum concurrent `worker` invocations. Clamped to `[1, items.length]`. */
  limit: number;
}

/**
 * Walk `items` and call `worker(item, index)` for each one, with at most
 * `options.limit` invocations outstanding at any time. Results come back in
 * the input order (`results[i]` corresponds to `items[i]`).
 */
export async function runPool<T, R>(
  items: readonly T[],
  options: RunPoolOptions,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results: R[] = Array.from({ length: n });
  if (n === 0) return results;
  const limit = Math.max(1, Math.min(options.limit | 0, n));

  let next = 0;
  const runOne = async (): Promise<void> => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= n) return;
      // Non-null assertion is safe: `i < n` guarantees the index is in range.
      results[i] = await worker(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runOne()));
  return results;
}
