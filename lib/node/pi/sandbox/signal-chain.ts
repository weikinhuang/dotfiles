/**
 * Re-deliver a signal that ASRT's cleanup listener swallows.
 *
 * `SandboxManager.initialize()` registers `process.once('SIGINT', reset)`
 * (and SIGTERM). Installing any listener removes Node's default
 * "terminate on SIGINT" behaviour, and ASRT's handler never re-raises,
 * so the first Ctrl-C on `pi -p` (which has no SIGINT handler of its
 * own) only tears the sandbox down and pi keeps running.
 *
 * {@link chainSignalListeners} replaces each listener ASRT added with a
 * one-shot wrapper that runs the original cleanup (bounded by a
 * timeout) and then re-sends the signal to the process, so whatever
 * handlers remain - or Node's default exit - see it as if ASRT had
 * never intercepted it. SIGTERM is left alone: pi turns it into a
 * graceful shutdown in every mode.
 *
 * Pure module: the process surface is injected for tests.
 */

export type SignalListener = (...args: unknown[]) => unknown;

/** Minimal process surface used here (a subset of `NodeJS.Process`). */
export interface SignalProcess {
  readonly pid: number;
  listeners(event: string): SignalListener[];
  removeListener(event: string, listener: SignalListener): unknown;
  once(event: string, listener: SignalListener): unknown;
  kill(pid: number, signal: string): unknown;
}

/** Snapshot the current listeners for `signal` (call before `initialize`). */
export function snapshotSignalListeners(proc: SignalProcess, signal: string): ReadonlySet<SignalListener> {
  return new Set(proc.listeners(signal));
}

/**
 * Wrap every `signal` listener that is not in `before` so it re-raises
 * the signal after running. Returns how many listeners were chained.
 * `timeoutMs` caps how long an async cleanup may delay the re-raise.
 */
export function chainSignalListeners(
  proc: SignalProcess,
  signal: string,
  before: ReadonlySet<SignalListener>,
  timeoutMs = 2000,
): number {
  const added = proc.listeners(signal).filter((l) => !before.has(l));
  for (const original of added) {
    proc.removeListener(signal, original);
    proc.once(signal, (...args: unknown[]) => {
      let settled = false;
      const reraise = (): void => {
        if (settled) return;
        settled = true;
        try {
          proc.kill(proc.pid, signal);
        } catch {
          // Nothing left to do if the process can't signal itself.
        }
      };
      const timer = setTimeout(reraise, timeoutMs);
      timer.unref?.();
      let result: unknown;
      try {
        result = original(...args);
      } catch {
        result = undefined;
      }
      void Promise.resolve(result)
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timer);
          reraise();
        });
    });
  }
  return added.length;
}
