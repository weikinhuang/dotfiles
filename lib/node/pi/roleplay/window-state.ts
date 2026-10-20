/**
 * Mutable per-process rolling context-window state for the `roleplay`
 * extension, grouped into one object so lifecycle resets are a single,
 * unit-testable call instead of a dozen scattered closure assignments.
 *
 * No pi imports.
 */

import { DEFAULT_CHARS_PER_TOKEN, planRecap } from './context-window.ts';

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
  /**
   * One-shot `/roleplay recap force`: the next context pass rolls the recap
   * regardless of the stride gate. Cleared once a recap actually starts, when
   * there is nothing uncovered to summarize, and on every full reset.
   */
  forceRecap: boolean;
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
    forceRecap: false,
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
  win.forceRecap = false;
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

/** Arm the one-shot forced roll (`/roleplay recap force`). */
export function armForcedRecap(win: WindowState): void {
  win.forceRecap = true;
}

export interface RollDecision {
  /** Roll this pass (stride gate OR an armed force with uncovered aged messages). */
  roll: boolean;
  /** The roll is due only because of the armed force. */
  forced: boolean;
}

/**
 * Decide whether this context pass rolls. The stride gate is
 * {@link planRecap}; an armed force additionally rolls when there are aged
 * messages the recap does not cover yet (`natural > recapCutoff`). A force
 * with nothing to cover is dropped (cleared) so it cannot linger.
 */
export function planRoll(win: WindowState, natural: number, stride: number): RollDecision {
  const strideRoll = planRecap(natural, win.committedCutoff, stride);
  if (!win.forceRecap) return { roll: strideRoll, forced: false };
  if (natural <= win.recapCutoff) {
    win.forceRecap = false;
    return { roll: strideRoll, forced: false };
  }
  return { roll: true, forced: !strideRoll };
}

/**
 * Settle the force after a roll: clear it once a recap actually started.
 * When an in-flight async recap blocked this roll, the force stays armed so
 * the next pass retries.
 */
export function settleForcedRecap(win: WindowState, recapStarted: boolean): void {
  if (recapStarted) win.forceRecap = false;
}
