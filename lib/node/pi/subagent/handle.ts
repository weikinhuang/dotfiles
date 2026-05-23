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
