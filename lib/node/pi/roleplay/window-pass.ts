/**
 * Pure per-turn planner for the roleplay rolling context window.
 *
 * The `roleplay` extension's `context` hook owns the side effects (async
 * recap execution, session-log writes, ctx reads); this module owns the
 * arithmetic that turns the window state into the reduced message list:
 *
 *   - {@link planWindowFloor}: the hard-safety floor (fit the session model's
 *     window) frozen between rolls, with an overflow valve.
 *   - {@link applyWindowPass}: layered drop + condense + recap / timeline
 *     injection (recap mode), the non-recap hard-drop floor, or the
 *     condense-only floor.
 *
 * No pi imports.
 */

import {
  applyContextWindowAt,
  applyLayeredWindow,
  computeCutoff,
  DEFAULT_CHARS_PER_TOKEN,
  deriveKeepTurns,
  estimateChars,
  freezeFloorCutoff,
  injectRecap,
  injectTimeline,
  type WindowOptions,
} from './context-window.ts';

/** A message is an opaque record; only `role` and `content` are read here. */
type Msg = Record<string, unknown>;

/** Tokens reserved for the model's own output plus injection/formatting slack (the fit target). */
export const FLOOR_RESERVE_TOKENS = 3072;
/** Minimum output margin; holding the frozen floor past this re-cuts it (the overflow valve). */
export const FLOOR_MIN_OUTPUT_TOKENS = 1024;

export interface PlanWindowFloorInput {
  messages: readonly Msg[];
  /** Session model context window in tokens; a non-positive / missing value disables the floor. */
  windowTokens: number | undefined;
  /** Chars of the system prompt sent with the request. */
  sysChars: number;
  /** Chars actually injected ahead of the conversation (recap + rendered timeline block). */
  injectChars: number;
  /** Calibrated chars per token; non-positive falls back to {@link DEFAULT_CHARS_PER_TOKEN}. */
  charsPerToken: number;
  /** Current frozen floor drop boundary. */
  frozenFloorCutoff: number;
  /** Current recap drop boundary (a recap that already drops more shrinks the held suffix). */
  recapCutoff: number;
}

export interface WindowFloorPlan {
  /** Next frozen floor (unchanged unless the overflow valve fired). */
  frozenFloorCutoff: number;
  /** Floor drop boundary to apply this turn (0 when the floor is disabled). */
  floorCutoff: number;
}

/**
 * Hard safety floor: guarantee the reduced prompt fits the session model's
 * context window even when the recap drop boundary cannot advance (an
 * empty / stale recap after a cold resume, or a dead recap endpoint). Drops
 * oldest whole user-turns beyond the token budget.
 *
 * The raw fit floor creeps forward a message or two every turn, so it is
 * FROZEN between rolls and only re-cut when holding the frozen floor would
 * overflow. The overflow valve keys on a LOOSER limit
 * ({@link FLOOR_MIN_OUTPUT_TOKENS}) than the fit target
 * ({@link FLOOR_RESERVE_TOKENS}) so the held prompt can grow into the output
 * reserve between rolls instead of re-cutting every turn.
 */
export function planWindowFloor(input: PlanWindowFloorInput): WindowFloorPlan {
  const { messages, windowTokens, sysChars, injectChars, frozenFloorCutoff, recapCutoff } = input;
  if (typeof windowTokens !== 'number' || !(windowTokens > 0)) return { frozenFloorCutoff, floorCutoff: 0 };
  const cpt = input.charsPerToken > 0 ? input.charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  const overheadTokens = Math.round((sysChars + injectChars) / cpt);
  const convBudget = windowTokens - overheadTokens - FLOOR_RESERVE_TOKENS;
  const fitTurns = convBudget > 0 ? deriveKeepTurns(messages, convBudget, cpt, 1, 100000) : 1;
  const rawFloor = computeCutoff(messages, fitTurns);
  const overflowLimit = windowTokens - overheadTokens - FLOOR_MIN_OUTPUT_TOKENS;
  // Estimate from where the drop actually holds: the larger of the frozen
  // floor and the recap drop boundary.
  const heldStart = Math.max(frozenFloorCutoff, recapCutoff);
  const heldConvTokens = heldStart > 0 ? estimateChars(messages.slice(heldStart)) / cpt : Infinity;
  const overflow = overflowLimit > 0 && heldConvTokens > overflowLimit;
  const next = freezeFloorCutoff({ frozen: frozenFloorCutoff, rawFloor, overflow });
  return { frozenFloorCutoff: next, floorCutoff: next };
}

export interface ApplyWindowPassInput {
  messages: readonly Msg[];
  /** Bounded recap mode (drop + inject) vs the condense-only / hard-drop floor. */
  recapMode: boolean;
  /** `max(recapCutoff, floorCutoff)`; the recap-mode drop boundary. */
  dropCutoff: number;
  /** Safety floor drop boundary; drives the non-recap hard drop when > 0. */
  floorCutoff: number;
  /** Frozen condense boundary. */
  committedCutoff: number;
  /** Cumulative recap text (recap mode only; blank is a no-op). */
  recapText: string;
  /** Rendered timeline block (recap mode only; null / blank is a no-op). */
  timelineBlock: string | null;
  opts: WindowOptions;
}

/**
 * Apply one window pass. Recap mode: layered drop + condense, then the recap
 * and timeline prefixes. Non-recap mode over budget (`floorCutoff > 0`):
 * hard-drop oldest turns + condense. Otherwise: condense-only floor.
 * `changed` mirrors whether the list was rewritten.
 */
export function applyWindowPass(input: ApplyWindowPassInput): { messages: readonly Msg[]; changed: boolean } {
  const { recapMode, dropCutoff, floorCutoff, committedCutoff, recapText, timelineBlock, opts } = input;
  let messages = input.messages;
  let changed = false;
  if (recapMode) {
    const layered = applyLayeredWindow(messages, dropCutoff, Math.max(dropCutoff, committedCutoff), opts);
    if (layered.dropped > 0 || layered.condensed > 0) {
      messages = layered.messages;
      changed = true;
    }
    // A blank recap must not splice an empty block (nor flip `changed`).
    if (recapText.trim()) {
      messages = injectRecap(messages, recapText);
      changed = true;
    }
    if (timelineBlock) {
      messages = injectTimeline(messages, timelineBlock);
      changed = true;
    }
  } else if (floorCutoff > 0) {
    const layered = applyLayeredWindow(messages, floorCutoff, committedCutoff, opts);
    if (layered.dropped > 0 || layered.condensed > 0) {
      messages = layered.messages;
      changed = true;
    }
  } else {
    const floor = applyContextWindowAt(messages, committedCutoff, opts);
    if (floor.condensed > 0) {
      messages = floor.messages;
      changed = true;
    }
  }
  return { messages, changed };
}
