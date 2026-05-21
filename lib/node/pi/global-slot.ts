/**
 * Cross-jiti-instance singleton slot helper.
 *
 * Pi's extension loader creates a fresh jiti instance per extension with
 * `moduleCache: false`. That means two extensions importing the same lib
 * helper each get their OWN module copy with their OWN module-level
 * state. For helpers that publish cross-extension singletons (active
 * persona, active sandbox config, active UI, the bash-gate slot, the
 * sandbox wrapper slot, the subagent-injection registry, ...), we work
 * around the duplication by anchoring the slot on `globalThis` behind a
 * `Symbol.for()` key — every jiti copy looks at the same property on the
 * same `globalThis`, so they share state.
 *
 * This module factors out the boilerplate so each new slot is a
 * one-liner.
 *
 * Usage:
 *
 *   interface MySlot { value?: T }
 *   const getMySlot = createGlobalSlot<MySlot>('@dotfiles/pi/whatever', () => ({}));
 *   export function publish(v: T): void { getMySlot().value = v; }
 *   export function read(): T | undefined { return getMySlot().value; }
 *
 * Pure module — no pi imports.
 */

/**
 * Build a getter that returns the (lazily-created) shared slot for
 * `key`. Subsequent calls in the same process — even from a different
 * jiti instance — return the same object identity.
 *
 * `init` runs at most once per process. If the slot already exists from
 * a different module copy, `init` is not invoked.
 */
export function createGlobalSlot<T extends object>(key: string, init: () => T): () => T {
  const symKey = Symbol.for(key);
  return () => {
    const g = globalThis as unknown as Record<symbol, T | undefined>;
    let slot = g[symKey];
    if (!slot) {
      slot = init();
      g[symKey] = slot;
    }
    return slot;
  };
}
