/**
 * A one-shot-ish "wake" primitive that lets an out-of-band event (the
 * ComfyUI progress websocket) cut a polling sleep short.
 *
 * `waitForImages` polls `/history` on a fixed interval as its reliable
 * floor - the websocket may never connect (auth) or may drop. But when
 * the socket *is* healthy it knows the instant a render finishes, so
 * rather than pay up to a full poll interval of latency after the fact,
 * the socket calls {@link Waker.wake} and the next sleep resolves
 * immediately. A wake that arrives mid-poll (while nothing is sleeping)
 * is latched so the following sleep still returns at once.
 *
 * Pure module - no pi imports; only `setTimeout`, like `abortable-delay`.
 */

export interface Waker {
  /** Cut any pending {@link sleep} short, or latch so the next one returns at once. */
  wake(): void;
  /**
   * Resolve after `ms`, early when {@link wake} fires, or reject with
   * `Error('aborted')` if `signal` fires first. A latched wake from
   * before the call is consumed and resolves on the next microtask.
   */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export function createWaker(): Waker {
  // Resolver of the in-flight sleep, if one is parked; and a latch for a
  // wake that landed while no sleep was pending.
  let resolvePending: (() => void) | null = null;
  let latched = false;

  return {
    wake(): void {
      if (resolvePending) {
        const resolve = resolvePending;
        resolvePending = null;
        resolve();
      } else {
        latched = true;
      }
    },

    sleep(ms: number, signal: AbortSignal): Promise<void> {
      if (latched) {
        latched = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        let timer: ReturnType<typeof setTimeout>;
        const finish = (): void => {
          clearTimeout(timer);
          resolvePending = null;
          resolve();
        };
        timer = setTimeout(finish, ms);
        resolvePending = finish;
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolvePending = null;
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    },
  };
}
