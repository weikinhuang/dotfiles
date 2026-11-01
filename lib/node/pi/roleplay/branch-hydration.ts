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

import { isSceneBoundary } from './scene-state.ts';

/** The recovered recap plus the exact coverage boundary it carried. */
export interface BranchRecap {
  recap: string;
  coveredTo: number;
  /** Stable first-uncovered message for coverage advanced by the token budget. */
  anchor?: string;
  /**
   * A pi compaction lies on the branch after the recap entry, so `coveredTo`
   * was reset to 0. The caller anchors its condense boundary at `natural`
   * (no immediate re-summarize of the compaction summary + kept messages).
   */
  compacted?: boolean;
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
 * Such a result carries `compacted: true`.
 *
 * Only a verified empty-text roll (`trivial: true, emptySpan: true`) can
 * advance coverage without a candidate. Older unverified trivial records
 * may have skipped meaningful short spans and are ignored for recovery.
 */
export function scanBranchForRecap(
  entries: readonly Record<string, unknown>[],
  natural: number,
  cast?: string,
): BranchRecap | null {
  let compactedAfter = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === 'compaction') {
      compactedAfter = true;
      continue;
    }
    if (e?.type !== 'custom') continue;
    if (isSceneBoundary(e)) return null;
    const ct = e.customType;
    if (ct !== 'roleplay-context-recap' && ct !== 'rp-context-recap') continue;
    const data = e.data as
      | {
          cast?: unknown;
          recap?: unknown;
          coveredTo?: unknown;
          anchor?: unknown;
          applied?: unknown;
          forced?: unknown;
          trivial?: unknown;
          emptySpan?: unknown;
        }
      | undefined;
    if (cast && typeof data?.cast === 'string' && data.cast !== cast) continue;
    if (data?.applied === false && data?.forced !== true && !(data?.trivial === true && data.emptySpan === true))
      continue;
    const text = typeof data?.recap === 'string' ? data.recap.trim() : '';
    if (!text) continue;
    if (compactedAfter) return { recap: text, coveredTo: 0, compacted: true };
    const coveredTo = typeof data?.coveredTo === 'number' ? data.coveredTo : 0;
    return {
      recap: text,
      coveredTo: Math.max(0, Math.min(coveredTo, natural)),
      ...(typeof data?.anchor === 'string' && data.anchor ? { anchor: data.anchor } : {}),
    };
  }
  return null;
}

/**
 * Recover this branch's cumulative timeline text from the session branch
 * (the `roleplay-timeline` custom audit entries). Entry shapes:
 *   - legacy (no `version`): `timeline` carries the FULL cumulative text,
 *   - v2 (`version: 2`): `beats` carries only the lines added by that roll,
 *     and the first v2 entry of a session seeded from the per-cast carry-over
 *     also carries `base` (the seed text the deltas were de-duped against).
 * Scans newest-first collecting v2 deltas until it reaches the newest base
 * (a non-empty legacy snapshot or a v2 `base`) or a `roleplay-newscene`
 * marker, then returns base + deltas in branch order (a v2 base entry's own
 * `beats` follow its base). A newscene marker shadows every older entry the
 * same way {@link scanBranchForRecap} handles the recap. Returns `null` when
 * nothing on the branch carries beats.
 */
export function scanBranchForTimeline(entries: readonly Record<string, unknown>[], cast?: string): string | null {
  const deltas: string[] = [];
  let base = '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== 'custom') continue;
    if (isSceneBoundary(e)) break;
    if (e.customType !== 'roleplay-timeline') continue;
    const data = e.data as
      | { cast?: unknown; timeline?: unknown; beats?: unknown; version?: unknown; base?: unknown }
      | undefined;
    if (cast && typeof data?.cast === 'string' && data.cast !== cast) continue;
    if (data?.version === 2) {
      const beats = typeof data.beats === 'string' ? data.beats.trim() : '';
      if (beats) deltas.push(beats);
      const v2Base = typeof data.base === 'string' ? data.base.trim() : '';
      if (v2Base) {
        base = v2Base;
        break;
      }
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
