/**
 * Single-signal abort wiring used by the `/btw` command shell.
 *
 * `onAbort` subscribes a handler to a parent `AbortSignal` and returns an
 * unsubscribe function that removes the listener on successful completion.
 * If the parent is already aborted the handler runs synchronously and a
 * shared no-op unsubscribe is returned (nothing was subscribed).
 *
 * This is intentionally distinct from `abort-merge.ts`'s
 * `mergeAbortSignals`: that one fuses two signals into one, this one wires
 * a single signal to a callback and hands back the teardown.
 *
 * Pure module - no pi imports.
 */

/** No-op unsubscribe. Shared so we don't allocate per call. */
export const NO_UNSUBSCRIBE = (): void => {
  // intentionally empty - nothing to clean up when there was nothing to subscribe.
};

/**
 * Wire a parent AbortSignal to a child handler, returning an
 * unsubscribe function that removes the listener on successful
 * completion. If the parent is already aborted we run the handler
 * synchronously.
 */
export function onAbort(signal: AbortSignal, handler: () => void): () => void {
  if (signal.aborted) {
    handler();
    return NO_UNSUBSCRIBE;
  }
  const listener = (): void => handler();
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}
