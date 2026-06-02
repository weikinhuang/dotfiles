/**
 * A `setTimeout` you can cancel via an `AbortSignal`. Generic enough to
 * reuse anywhere an extension wants to sleep between polls but bail out
 * the moment the turn is aborted (e.g. the comfyui `/history` poll loop).
 *
 * Pure module - no pi imports.
 */

/**
 * Resolve after `ms` milliseconds, or reject with `Error('aborted')` if
 * `signal` fires first. An already-aborted signal rejects on the next
 * microtask without arming a timer. The timer is cleared on abort so it
 * never leaks past the rejection.
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
