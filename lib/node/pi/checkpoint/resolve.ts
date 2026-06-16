/**
 * Turn a navigation move (oldLeaf → newLeaf) into the per-file restore
 * targets, treating every move uniformly as **undo back to the common
 * ancestor, then redo forward to the new leaf** (Claude Code-style code
 * follows the conversation, backward / forward / cross-branch alike).
 *
 * Two pure layers:
 *
 *   1. {@link resolveLegs} - given the root→leaf ancestry path of each leaf
 *      (the pi-coupled bit that fetches these lives in the shell), find the
 *      common ancestor and split the entry ids into the undo leg (old →
 *      ancestor, newest-first) and the redo leg (ancestor → new,
 *      oldest-first).
 *
 *   2. {@link computeFileTargets} - given the manifests on each leg, compute
 *      for every touched file its `target` (recorded content at the new
 *      leaf) and `expectedCurrent` (recorded content at the old leaf), as
 *      blob hashes or `null` (absent). `conflict.ts` then classifies disk
 *      against these, and `restore.ts` turns the selected targets into a
 *      write/delete plan.
 *
 * The model that makes both legs fall out of one rule: each manifest entry
 * records `before` (the file's state at its PARENT node) and `after` (its
 * state at THIS node). So the state at the common ancestor for a file is the
 * `before` of the first manifest after the ancestor that touched it.
 *
 * No pi imports - operates on plain ancestry arrays + manifests.
 */

import type { CheckpointEntry, CheckpointManifest, FileTarget } from './types.ts';

export interface ResolvedLegs {
  /** Last shared ancestor id, or undefined if the paths share no prefix. */
  commonAncestorId: string | undefined;
  /** Entry ids old→ancestor (exclusive), newest-first = restore-apply order. */
  undo: string[];
  /** Entry ids ancestor→new (exclusive), oldest-first = restore-apply order. */
  redo: string[];
}

/**
 * Split two root→leaf ancestry paths into undo + redo legs around their
 * common ancestor. `oldPath`/`newPath` are ordered root-first (root … leaf),
 * each element a session-tree entry id.
 *
 *   - common ancestor = the last element of the shared leading prefix.
 *   - undo = oldPath entries strictly below the ancestor, reversed so the
 *     newest (the old leaf) is applied first.
 *   - redo = newPath entries strictly below the ancestor, left oldest-first.
 *
 * Pure backward nav → empty redo; pure forward nav → empty undo; a
 * cross-branch jump → both non-empty.
 */
export function resolveLegs(oldPath: readonly string[], newPath: readonly string[]): ResolvedLegs {
  let i = 0;
  while (i < oldPath.length && i < newPath.length && oldPath[i] === newPath[i]) i++;
  const commonAncestorId = i > 0 ? oldPath[i - 1] : undefined;
  const undo = oldPath.slice(i).reverse();
  const redo = newPath.slice(i);
  return { commonAncestorId, undo, redo };
}

/** Index manifests by their anchor entry id for leg lookups. */
export function manifestsById(manifests: readonly CheckpointManifest[]): Map<string, CheckpointManifest> {
  const map = new Map<string, CheckpointManifest>();
  for (const m of manifests) map.set(m.leafEntryId, m);
  return map;
}

/**
 * Resolve the ordered manifests on a leg from its entry ids, dropping ids
 * that carry no manifest (most tree nodes don't). Order is preserved, so an
 * undo leg stays newest-first and a redo leg stays oldest-first.
 */
export function manifestsForLeg(
  legIds: readonly string[],
  byId: Map<string, CheckpointManifest>,
): CheckpointManifest[] {
  const out: CheckpointManifest[] = [];
  for (const id of legIds) {
    const m = byId.get(id);
    if (m !== undefined) out.push(m);
  }
  return out;
}

/** Flatten a leg's manifests to a single ordered entry list (manifest order, entry order within). */
function legEntries(manifests: readonly CheckpointManifest[]): CheckpointEntry[] {
  const out: CheckpointEntry[] = [];
  for (const m of manifests) for (const e of m.entries) out.push(e);
  return out;
}

/**
 * Compute per-file `target` / `expectedCurrent` for a move.
 *
 * `undoManifests` are newest-first (old → ancestor); `redoManifests` are
 * oldest-first (ancestor → new). For each file F touched on either leg:
 *
 *   - ancestorState(F): the `before` of the manifest closest to the ancestor
 *     that touched F - the first redo entry if F is on the redo leg, else the
 *     last (oldest) undo entry.
 *   - target(F) = state at new leaf: the `after` of the newest redo entry for
 *     F; if F isn't on the redo leg it stays at the ancestor state.
 *   - expectedCurrent(F) = state at old leaf: the `after` of the newest undo
 *     entry for F (undo is newest-first ⇒ the first one); if F isn't on the
 *     undo leg it's still at the ancestor state.
 *
 * Files whose `target` equals `expectedCurrent` are still returned (the
 * caller / `conflict.ts` will classify them no-op against disk).
 */
export function computeFileTargets(
  undoManifests: readonly CheckpointManifest[],
  redoManifests: readonly CheckpointManifest[],
): FileTarget[] {
  const undo = legEntries(undoManifests); // newest-first
  const redo = legEntries(redoManifests); // oldest-first

  const paths = new Set<string>();
  for (const e of undo) paths.add(e.path);
  for (const e of redo) paths.add(e.path);

  const out: FileTarget[] = [];
  for (const path of paths) {
    const undoForFile = undo.filter((e) => e.path === path); // newest-first
    const redoForFile = redo.filter((e) => e.path === path); // oldest-first

    // State at the common ancestor.
    let ancestorState: string | null;
    if (redoForFile.length > 0) {
      ancestorState = redoForFile[0].before; // first redo entry's parent-state
    } else {
      // undoForFile is newest-first, so the last element is closest to ancestor.
      ancestorState = undoForFile[undoForFile.length - 1].before;
    }

    const target = redoForFile.length > 0 ? redoForFile[redoForFile.length - 1].after : ancestorState;
    const expectedCurrent = undoForFile.length > 0 ? undoForFile[0].after : ancestorState;

    out.push({ path, target, expectedCurrent });
  }

  // Stable ordering by path for deterministic review rows + specs.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * End-to-end convenience: given both ancestry paths and the full manifest
 * set, produce the per-file targets. The shell uses this directly.
 */
export function resolveFileTargets(
  oldPath: readonly string[],
  newPath: readonly string[],
  manifests: readonly CheckpointManifest[],
): { legs: ResolvedLegs; targets: FileTarget[] } {
  const legs = resolveLegs(oldPath, newPath);
  const byId = manifestsById(manifests);
  const undoManifests = manifestsForLeg(legs.undo, byId);
  const redoManifests = manifestsForLeg(legs.redo, byId);
  const targets = computeFileTargets(undoManifests, redoManifests);
  return { legs, targets };
}
