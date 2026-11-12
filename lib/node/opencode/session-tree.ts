/**
 * Session-hierarchy helpers for opencode plugins.
 *
 * opencode subagents run in child sessions whose `Session.Info.parentID`
 * points at the session that spawned them. Plugins that should act once per
 * user-facing turn (notifications, budgets, ...) need the root of that tree.
 * The lookup itself (`ctx.session.get`) is injected so this stays pure and
 * unit-testable.
 *
 * Pure module - no opencode imports.
 */

/** Returns the parent session id, or `undefined` for a root session. */
export type ParentLookup = (sessionID: string) => Promise<string | undefined>;

/** Guard against a malformed (cyclic or absurdly deep) parent chain. */
export const MAX_SESSION_DEPTH = 32;

/**
 * Wrap `lookup` with a per-id memo. A session's parent never changes, so a
 * plugin can keep one cache for its lifetime. Failed lookups are not cached.
 */
export function cacheParentLookup(lookup: ParentLookup): ParentLookup {
  const cache = new Map<string, string | undefined>();
  return async (sessionID) => {
    if (cache.has(sessionID)) return cache.get(sessionID);
    const parent = await lookup(sessionID);
    cache.set(sessionID, parent);
    return parent;
  };
}

/** True when `sessionID` has no parent. */
export async function isRootSession(sessionID: string, lookup: ParentLookup): Promise<boolean> {
  return (await lookup(sessionID)) === undefined;
}

/**
 * Walk `parentID` links up to the root session. Stops at
 * {@link MAX_SESSION_DEPTH} hops or on a cycle and returns the last id
 * reached, so a corrupt chain degrades to "some ancestor" instead of hanging.
 */
export async function resolveRootSessionID(sessionID: string, lookup: ParentLookup): Promise<string> {
  // Each hop depends on the previous one, so walk recursively rather than awaiting in a loop.
  const walk = async (current: string, seen: Set<string>): Promise<string> => {
    if (seen.size > MAX_SESSION_DEPTH) return current;
    const parent = await lookup(current);
    if (parent === undefined || seen.has(parent)) return current;
    seen.add(parent);
    return walk(parent, seen);
  };
  return walk(sessionID, new Set([sessionID]));
}
