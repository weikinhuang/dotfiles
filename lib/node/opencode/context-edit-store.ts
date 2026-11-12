/**
 * Per-session directive store for the opencode `context-edit` plugin.
 *
 * Wraps the plugin's durable key/value storage (`ctx.storage`, injected so
 * this stays testable) with an in-memory cache and a per-session mutation
 * queue: the `context` hook reads on every request, while the TUI (over
 * RPC) and the model tools write. Each write stores the FULL directive set
 * under `session/<sessionID>`, mirroring pi's whole-snapshot persistence,
 * so a restart reloads exactly the last state.
 *
 * Pure module - no opencode imports.
 */

import { type ContextEditState, cloneState } from '../pi/context-edit/directive.ts';
import { parseStoredState } from './context-edit.ts';

/** The subset of `ctx.storage` the store needs. */
export interface KeyValueStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: ContextEditState): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface DirectiveStore {
  /** Current state for a session (loaded once, then cached). */
  get(sessionID: string): Promise<ContextEditState>;
  /**
   * Apply `mutate` to the latest state and persist the result. Mutations
   * for one session run one at a time. Returning `undefined` skips the
   * write. Resolves with the stored (or unchanged) state.
   */
  update(
    sessionID: string,
    mutate: (state: ContextEditState) => ContextEditState | undefined,
  ): Promise<ContextEditState>;
  /** Drop a session's cache entry and stored state (session deleted). */
  forget(sessionID: string): Promise<void>;
}

export function storageKey(sessionID: string): string {
  return `session/${sessionID}`;
}

export function createDirectiveStore(storage: KeyValueStorage): DirectiveStore {
  const cache = new Map<string, Promise<ContextEditState>>();
  const queues = new Map<string, Promise<unknown>>();

  const get = (sessionID: string): Promise<ContextEditState> => {
    let hit = cache.get(sessionID);
    if (!hit) {
      hit = storage.get(storageKey(sessionID)).then(parseStoredState);
      // A failed read is retried on the next call instead of caching the rejection.
      void hit.catch(() => cache.delete(sessionID));
      cache.set(sessionID, hit);
    }
    return hit;
  };

  const update: DirectiveStore['update'] = (sessionID, mutate) => {
    // Mutations queue per session; a failed one leaves the cached state as it was.
    const previous = queues.get(sessionID) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const state = await get(sessionID);
        const changed = mutate(cloneState(state));
        if (!changed) return state;
        if (changed.directives.length === 0) await storage.remove(storageKey(sessionID));
        else await storage.set(storageKey(sessionID), changed);
        cache.set(sessionID, Promise.resolve(changed));
        return changed;
      });
    queues.set(sessionID, run);
    return run;
  };

  const forget = async (sessionID: string): Promise<void> => {
    cache.delete(sessionID);
    queues.delete(sessionID);
    await storage.remove(storageKey(sessionID));
  };

  return { get, update, forget };
}
