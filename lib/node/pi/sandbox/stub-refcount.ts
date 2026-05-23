/**
 * Tiny path -> refcount helper used by the sandbox extension to track
 * which dangerous-file stubs are still in flight across concurrent
 * bash calls (bg-bash makes this real - two background bash commands
 * can overlap on the same set of stubs).
 *
 * The stubs themselves are created in cwd by `dangerous-file-stubs.ts`
 * before each `wrapWithSandbox` call, so bwrap doesn't race on the
 * mount-point creation. Without per-command cleanup the stubs sit in
 * the working tree for the whole session; with naive per-command
 * cleanup, command A finishing would unlink stubs that command B is
 * still using mid-startup. Reference-counting closes that gap: each
 * `wrapWithSandbox` increments the count for every stub it touched
 * (including ones that already existed and got adopted via the
 * EEXIST path); each matching `tool_result` decrements; the cleanup
 * helper only unlinks paths whose count has dropped to zero.
 *
 * Pure module - no pi imports - so it's unit-testable under vitest.
 */

/**
 * Increment the refcount for each path in `paths` against `map`.
 * Mutates `map` in place. Missing keys default to 0.
 */
export function incStubRefs(map: Map<string, number>, paths: Iterable<string>): void {
  for (const abs of paths) {
    map.set(abs, (map.get(abs) ?? 0) + 1);
  }
}

/**
 * Decrement the refcount for each path in `paths` against `map`.
 * Returns the absolute paths whose refcount has dropped to zero (or
 * below); those entries are deleted from `map` so the caller can pass
 * the returned list straight to `cleanupDangerousFileStubs`. Paths
 * that aren't present in `map` are treated as count=1 (so a single
 * decrement removes them) - that matches the create-then-decrement
 * flow where every path going in came from an `incStubRefs` on the
 * same map. Mutates `map` in place.
 */
export function decStubRefs(map: Map<string, number>, paths: Iterable<string>): string[] {
  const removed: string[] = [];
  for (const abs of paths) {
    const next = (map.get(abs) ?? 1) - 1;
    if (next <= 0) {
      map.delete(abs);
      removed.push(abs);
    } else {
      map.set(abs, next);
    }
  }
  return removed;
}
