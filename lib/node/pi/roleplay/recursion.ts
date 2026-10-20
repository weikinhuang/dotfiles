/**
 * Pure bounded recursion for the roleplay lorebook.
 *
 * No pi imports - unit-testable under `vitest`.
 *
 * SillyTavern's "recursive scanning" lets a fired entry's body trigger
 * further entries. Here it is off by default and opt-in per entry: only
 * entries whose `recurse` flag is set have their bodies re-scanned, and
 * the whole expansion is hard-capped at `maxRecursion` passes so a
 * mutually-referential lorebook can't loop unbounded.
 *
 * Two entry points:
 *   - {@link expandMatchedRecursive} (preferred) runs BEFORE the timing
 *     pass: it expands the keyword-matched set and returns the union of
 *     matched ids, which the caller feeds to `applyTiming` once as the
 *     `matched` flag. Recursively matched entries therefore go through
 *     delay / cooldown / probability / sticky / inclusion-group exactly
 *     like keyword matches.
 *   - {@link expandRecursive} (legacy) expands an already-timed fired set
 *     with plain keyword matching, so recursive hits bypass timing.
 */

import { matchLore } from './match.ts';
import { type RoleplayEntry } from './store.ts';

/** Hard ceiling on recursion passes regardless of config. */
export const MAX_RECURSION_CAP = 2;

export interface RecursionOptions {
  /** Bodies for re-scanning, keyed by entry id. Missing ids contribute no text. */
  bodyOf: (entry: RoleplayEntry) => string;
  /** Requested passes; clamped to `[0, MAX_RECURSION_CAP]`. */
  maxRecursion?: number;
}

function expand(
  initialFired: readonly RoleplayEntry[],
  allEntries: readonly RoleplayEntry[],
  opts: RecursionOptions,
): RoleplayEntry[] {
  const passes = Math.max(0, Math.min(MAX_RECURSION_CAP, Math.floor(opts.maxRecursion ?? 0)));
  const fired = new Map<string, RoleplayEntry>();
  for (const e of initialFired) fired.set(e.id, e);

  let frontier = initialFired.filter((e) => e.lore?.recurse);
  for (let pass = 0; pass < passes && frontier.length > 0; pass++) {
    const scanText = frontier.map((e) => opts.bodyOf(e)).join('\n');
    const candidates = allEntries.filter((e) => !fired.has(e.id));
    const newly = matchLore(candidates, scanText);
    if (newly.length === 0) break;
    for (const e of newly) fired.set(e.id, e);
    frontier = newly.filter((e) => e.lore?.recurse);
  }

  return [...fired.values()];
}

/**
 * Expand an initial fired set by re-scanning the bodies of fired entries
 * that opted into recursion (`recurse: true`). Returns every fired entry
 * (initial + newly triggered), de-duplicated, in firing order.
 *
 * Each pass scans the concatenated bodies of the current `recurse`-enabled
 * frontier against the not-yet-fired lore entries; newly fired entries
 * that themselves opt into recursion form the next frontier. Stops when no
 * new entries fire or the clamped pass budget is exhausted.
 */
export function expandRecursive(
  initialFired: readonly RoleplayEntry[],
  allEntries: readonly RoleplayEntry[],
  opts: RecursionOptions,
): RoleplayEntry[] {
  return expand(initialFired, allEntries, opts);
}

/**
 * Pre-timing recursion. Starting from the keyword-matched entries
 * (`initialMatched`, typically `matchLore(pool, scanText)`), re-scan the
 * bodies of matched entries that opted into recursion (`recurse: true`)
 * against the rest of `pool`, up to the clamped pass budget, and return
 * the full matched id set (initial + recursive matches).
 *
 * Semantics: recursion sources are keyword-MATCHED entries, evaluated
 * before timing. A matched entry whose own timing later suppresses it
 * (delay, cooldown, failed probability roll, lost inclusion group) still
 * contributed its body to the scan; timing then filters the whole union
 * uniformly. Sticky carries that did not match this turn are not
 * recursion sources. This keeps the timing pass single-shot per turn.
 */
export function expandMatchedRecursive(
  initialMatched: readonly RoleplayEntry[],
  pool: readonly RoleplayEntry[],
  opts: RecursionOptions,
): Set<string> {
  return new Set(expand(initialMatched, pool, opts).map((e) => e.id));
}
