/**
 * Mutable per-process rolling context-window state for the `roleplay`
 * extension, grouped into one object so lifecycle resets are a single,
 * unit-testable call instead of a dozen scattered closure assignments.
 *
 * No pi imports.
 */

import { DEFAULT_CHARS_PER_TOKEN } from './context-window.ts';

export interface WindowState {
  /** Cumulative scene memory injected as a prefix (mirrors the `summary/auto` record). */
  recapText: string;
  /** Cumulative append-log of dated story beats injected as a prefix (mirrors the `timeline/auto` record). */
  timelineText: string;
  /** FROZEN condense boundary; messages[0..committedCutoff) are the aged prefix. Advances only on a roll. */
  committedCutoff: number;
  /** How much of the aged prefix the recap covers; messages[0..recapCutoff) are DROPPED in recap mode. */
  recapCutoff: number;
  /**
   * FROZEN hard-safety floor drop boundary. Advances only on a real overflow,
   * never per-turn, so the drop / recap-injection anchor stays byte-stable
   * between rolls and the prompt-prefix cache survives.
   */
  frozenFloorCutoff: number;
  /** One-shot hydrate of `recapText` from the durable record per (re)load. */
  recapHydrated: boolean;
  /** Generation counter; invalidates an in-flight async recap after a reset / branch change. */
  recapGen: number;
  recapInFlight: boolean;
  recapAbort: AbortController | null;
  /** Calibrated chars-per-token (blended toward the last turn's reported usage). Survives resets. */
  charsPerToken: number;
  /** Estimated chars of the prompt we sent last turn, for usage calibration next turn. */
  lastSentEstChars: number;
  /** Safety-floor anchor carried between final-projection limiter passes. */
  projectedFloorAnchor: string | undefined;
}

export function createWindowState(): WindowState {
  return {
    recapText: '',
    timelineText: '',
    committedCutoff: 0,
    recapCutoff: 0,
    frozenFloorCutoff: 0,
    recapHydrated: false,
    recapGen: 0,
    recapInFlight: false,
    recapAbort: null,
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
    lastSentEstChars: 0,
    projectedFloorAnchor: undefined,
  };
}

/**
 * Invalidate any in-flight async recap: bump the generation (so a late
 * result is discarded as stale), clear the in-flight flag, and abort its
 * controller (best-effort, never throws).
 */
export function invalidateRecap(win: WindowState): void {
  win.recapGen += 1;
  win.recapInFlight = false;
  if (win.recapAbort) {
    try {
      win.recapAbort.abort();
    } catch {
      /* ignore */
    }
    win.recapAbort = null;
  }
}

/**
 * Full lifecycle reset (session start / tree change / shorter conversation):
 * drop recap + timeline text, all coverage, the hydrate guard, and the usage
 * calibration sample; invalidate any in-flight recap. `charsPerToken` is a
 * measurement, not session state, so it survives.
 */
export function resetWindowState(win: WindowState): void {
  win.recapText = '';
  win.timelineText = '';
  win.committedCutoff = 0;
  win.recapCutoff = 0;
  win.frozenFloorCutoff = 0;
  win.recapHydrated = false;
  win.lastSentEstChars = 0;
  win.projectedFloorAnchor = undefined;
  invalidateRecap(win);
}

/**
 * Post-compaction reset: the message array is new and shorter, so every
 * index-valued cutoff is stale. Keep the recap / timeline TEXT (still the
 * scene memory) and the floor anchor, but zero coverage and invalidate any
 * in-flight recap (its `spanTo` indexes the old array).
 */
export function resetWindowCoverage(win: WindowState): void {
  invalidateRecap(win);
  win.recapCutoff = 0;
  win.committedCutoff = 0;
  win.frozenFloorCutoff = 0;
  win.lastSentEstChars = 0;
}
