/**
 * Pure helpers for generating and resolving subagent handles used by
 * the background-mode registry in the subagent extension.
 *
 * A "handle" is the short, human-typeable identifier surfaced to the
 * parent LLM so it can refer to a running child in later tool calls
 * (`subagent_send({ to: handle, ... })`). Shape:
 *
 *   sub_<agentName>_<index>
 *
 * where <index> is a monotonically increasing integer scoped to the
 * current parent session. The counter resets on `session_start` so
 * handles stay short across a long day of work; cross-session
 * collisions never matter because the extension only looks up
 * handles inside its current in-memory registry.
 *
 * Deliberately pure - no pi imports - so vitest can exercise it
 * without the full pi runtime.
 */

export interface HandleCounter {
  next(agentName: string): string;
  reset(): void;
}

export function makeHandleCounter(): HandleCounter {
  let n = 0;
  return {
    next(agentName: string): string {
      n++;
      return `sub_${agentName}_${n.toString(10)}`;
    },
    reset(): void {
      n = 0;
    },
  };
}

/**
 * Resolve a user-supplied id against a registry keyed by handle.
 * Accepts:
 *   - the canonical short handle (`sub_explore_3`)
 *   - the full child session id (fallback - handy if a prior
 *     assistant turn echoed the session id instead of the handle,
 *     since pi audit entries expose both)
 * Returns the matching entry or `undefined`.
 */
export function resolveHandle<T extends { childSessionId: string }>(
  input: string,
  byHandle: ReadonlyMap<string, T>,
): T | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  const direct = byHandle.get(trimmed);
  if (direct) return direct;
  for (const entry of byHandle.values()) {
    if (entry.childSessionId === trimmed) return entry;
  }
  return undefined;
}

/**
 * Eviction policy for the background-children registry (keyed by handle).
 * When the registry exceeds `cap`, drop the oldest *completed* entries
 * (`running === false`) until it fits or no more completed entries remain -
 * running children are never evicted. `Map` iteration order is insertion
 * order, so the walk visits oldest-first. Mutates `registry` in place.
 *
 * Pure aside from the `Map` mutation the caller owns - no env / clock reads,
 * so the `cap` is resolved by the caller (from `PI_SUBAGENT_BG_MAX`).
 */
export function pruneBackgroundRegistry<T extends { running: boolean }>(registry: Map<string, T>, cap: number): void {
  if (registry.size <= cap) return;
  const toDrop: string[] = [];
  let overflow = registry.size - cap;
  for (const [handle, entry] of registry) {
    if (overflow <= 0) break;
    if (!entry.running) {
      toDrop.push(handle);
      overflow--;
    }
  }
  for (const h of toDrop) registry.delete(h);
}
