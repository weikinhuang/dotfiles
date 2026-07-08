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
 */
export function scanBranchForRecap(entries: readonly Record<string, unknown>[], natural: number): BranchRecap | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== 'custom') continue;
    if (e.customType === 'roleplay-newscene') return null;
    const ct = e.customType;
    if (ct !== 'roleplay-context-recap' && ct !== 'rp-context-recap') continue;
    const data = e.data as { recap?: unknown; coveredTo?: unknown; applied?: unknown; forced?: unknown } | undefined;
    if (data?.applied === false && data?.forced !== true) continue;
    const text = typeof data?.recap === 'string' ? data.recap.trim() : '';
    if (!text) continue;
    const coveredTo = typeof data?.coveredTo === 'number' ? data.coveredTo : 0;
    return { recap: text, coveredTo: Math.max(0, Math.min(coveredTo, natural)) };
  }
  return null;
}

/**
 * Recover this branch's cumulative timeline text from the session branch
 * (the `roleplay-timeline` custom audit entries, each stamped with the full
 * cumulative timeline). Scans newest-first for the latest non-empty
 * snapshot. A `roleplay-newscene` marker shadows all older timeline
 * snapshots the same way {@link scanBranchForRecap} handles the recap.
 */
export function scanBranchForTimeline(entries: readonly Record<string, unknown>[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== 'custom') continue;
    if (e.customType === 'roleplay-newscene') return null;
    if (e.customType !== 'roleplay-timeline') continue;
    const data = e.data as { timeline?: unknown } | undefined;
    const text = typeof data?.timeline === 'string' ? data.timeline.trim() : '';
    if (text) return text;
  }
  return null;
}
