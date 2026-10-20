/**
 * Pure newest-first scanners over a pi session branch (the array returned
 * by `sessionManager.getBranch()`) that rebuild roleplay's rolling-window
 * state on (re)load.
 *
 * The pi-coupled glue - calling `getBranch()` and its try/catch - stays in
 * the extension shell; these reducers take the already-materialised entries
 * array and are fully unit-testable with no pi imports. `getBranch()` only
 * returns entries on the active root-to-leaf path, so a resume/fork
 * rehydrates the state that belongs to ITS branch, never a sibling's.
 */

/** The recovered recap plus the exact coverage boundary it carried. */
export interface BranchRecap {
  recap: string;
  coveredTo: number;
}

/**
 * Recover a running recap from the session branch (the
 * `roleplay-context-recap` / legacy `rp-context-recap` custom audit
 * entries). Scans newest-first for the last applied recap.
 *
 * A `roleplay-newscene` marker seen before any recap means the scene was
 * archived and there is no recap since -> cold start (`null`); it shadows
 * every older recap entry that cannot be deleted from the branch. A
 * force-accepted roll (`applied=false` + `forced=true`) is treated as
 * committed so the drain progress it made survives a reload. `coveredTo`
 * is clamped to `[0, natural]`.
 *
 * A pi `compaction` entry seen before the recap (i.e. lying on the branch
 * AFTER it) invalidates the recorded `coveredTo`: it indexes the
 * PRE-compaction message array, while the context now starts with the
 * compaction summary + kept messages. The recap text is kept (it is still
 * the scene's narrative memory) but coverage resets to 0, so nothing in the
 * new, shorter array is dropped on the stale index; normal rolls re-anchor it.
 */
export function scanBranchForRecap(entries: readonly Record<string, unknown>[], natural: number): BranchRecap | null {
  let compactedAfter = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === 'compaction') {
      compactedAfter = true;
      continue;
    }
    if (e?.type !== 'custom') continue;
    if (e.customType === 'roleplay-newscene') return null;
    const ct = e.customType;
    if (ct !== 'roleplay-context-recap' && ct !== 'rp-context-recap') continue;
    const data = e.data as { recap?: unknown; coveredTo?: unknown; applied?: unknown; forced?: unknown } | undefined;
    if (data?.applied === false && data?.forced !== true) continue;
    const text = typeof data?.recap === 'string' ? data.recap.trim() : '';
    if (!text) continue;
    if (compactedAfter) return { recap: text, coveredTo: 0 };
    const coveredTo = typeof data?.coveredTo === 'number' ? data.coveredTo : 0;
    return { recap: text, coveredTo: Math.max(0, Math.min(coveredTo, natural)) };
  }
  return null;
}

/**
 * Recover this branch's cumulative timeline text from the session branch
 * (the `roleplay-timeline` custom audit entries). Two entry shapes:
 *   - legacy (no `version`): `timeline` carries the FULL cumulative text,
 *   - v2 (`version: 2`): `beats` carries only the lines added by that roll.
 * Scans newest-first collecting v2 deltas until it reaches the newest
 * non-empty legacy snapshot (the base) or a `roleplay-newscene` marker,
 * then returns base + deltas in branch order. A newscene marker shadows
 * every older entry the same way {@link scanBranchForRecap} handles the
 * recap. Returns `null` when nothing on the branch carries beats.
 */
export function scanBranchForTimeline(entries: readonly Record<string, unknown>[]): string | null {
  const deltas: string[] = [];
  let base = '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== 'custom') continue;
    if (e.customType === 'roleplay-newscene') break;
    if (e.customType !== 'roleplay-timeline') continue;
    const data = e.data as { timeline?: unknown; beats?: unknown; version?: unknown } | undefined;
    if (data?.version === 2) {
      const beats = typeof data.beats === 'string' ? data.beats.trim() : '';
      if (beats) deltas.push(beats);
      continue;
    }
    const text = typeof data?.timeline === 'string' ? data.timeline.trim() : '';
    if (text) {
      base = text;
      break;
    }
  }
  const parts = [base, ...deltas.reverse()].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('\n') : null;
}
