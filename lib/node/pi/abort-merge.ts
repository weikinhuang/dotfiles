/**
 * Merge two optional `AbortSignal`s into a single signal that aborts as
 * soon as either input does. Used to thread independent cancellation
 * sources (a user-initiated cancel, a deadline timer, a parent flow's
 * signal) into a child spawner without that spawner having to know which
 * source fired.
 *
 *   - If neither input is supplied, returns `undefined` (callers pass it
 *     straight through to downstream APIs that treat `undefined` as
 *     "no cancellation").
 *   - If exactly one is supplied, returns it directly (avoids the cost
 *     of a wrapper controller for the common single-source case).
 *   - If both are supplied, returns the signal of a new
 *     `AbortController` that aborts when either source does, forwarding
 *     the abort `reason`.
 *
 * This is intentionally distinct from `lib/node/pi/research/fanout.ts`'s
 * deadline-merge helper - that one returns the full `AbortController`
 * and ties to a wall-clock deadline. This is the pure pass-through
 * variant for spawners that just need a unified signal.
 *
 * Pure module - no pi imports.
 */

export function mergeAbortSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const ac = new AbortController();
  const onAbort = (reason: unknown): void => {
    if (!ac.signal.aborted) ac.abort(reason);
  };
  if (a.aborted) onAbort(a.reason);
  else a.addEventListener('abort', () => onAbort(a.reason), { once: true });
  if (b.aborted) onAbort(b.reason);
  else b.addEventListener('abort', () => onAbort(b.reason), { once: true });
  return ac.signal;
}
