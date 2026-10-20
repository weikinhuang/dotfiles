/**
 * Per-cast lorebook + scene-fold timing state for the `roleplay` extension,
 * grouped into one object so the cast-switch reset is a single,
 * unit-testable call.
 *
 * No pi imports.
 */

import type { TimingState } from './timing.ts';

export interface CastTimingState {
  /** Monotonic per-turn counter driving lorebook timing (`delay` / `sticky` / `cooldown`). */
  turnCount: number;
  /** Per-entry lorebook timing state, keyed by entry id. */
  timingState: Record<string, TimingState>;
  /** Per-character scene-fold timing state (sticky/cooldown), keyed by character id. */
  sceneTimingState: Record<string, TimingState>;
  /** Narrative turn each name-triggered sheet was last delivered in a `roleplay-scene-fold` reminder. */
  sceneFoldDelivered: Map<string, number>;
  /** Name-triggered ids active on the previous narrative turn (re-entry detection). */
  sceneFoldPriorActive: Set<string>;
}

export function createCastTimingState(): CastTimingState {
  return {
    turnCount: 0,
    timingState: {},
    sceneTimingState: {},
    sceneFoldDelivered: new Map(),
    sceneFoldPriorActive: new Set(),
  };
}

/** Drop scene-fold delivery bookkeeping only (session shutdown keeps lorebook timing). */
export function resetSceneFoldDelivery(t: CastTimingState): void {
  t.sceneFoldDelivered = new Map();
  t.sceneFoldPriorActive = new Set();
}

/** A cast switch resets all lorebook + scene-fold timing (sticky windows / cooldowns / turn count). */
export function resetCastTiming(t: CastTimingState): void {
  t.turnCount = 0;
  t.timingState = {};
  t.sceneTimingState = {};
  resetSceneFoldDelivery(t);
}
