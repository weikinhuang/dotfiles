/**
 * Shared types for the `avatar` pi extension and its pure helpers.
 *
 * Pure module - no pi runtime, no `@earendil-works/*` imports - so it
 * is unit-testable under the root vitest suite and type-checked by the
 * repo `tsconfig.json`.
 */

/** Image protocols the minimal renderer can target, plus the text fallback. */
export type Protocol = 'kitty' | 'iterm2' | 'ascii';

/**
 * Activity states driven automatically off pi lifecycle events. Each maps
 * to a sprite subdirectory of an emote set (e.g. `default/think/`) or a
 * same-named key in the kaomoji set.
 */
export const ACTIVITY_STATES = [
  'hi',
  'idle',
  'wait',
  'think',
  'talk',
  'read',
  'write',
  'tool',
  'success',
  'failure',
  'compact',
] as const;

export type ActivityState = (typeof ACTIVITY_STATES)[number];

/** Glob `model` pattern -> emote-set name mapping (last match wins). */
export interface EmoteMapping {
  model: string;
  'emote-set': string;
}

/** Hold durations (ms) for the transient states before they auto-transition. */
export interface HoldDuration {
  hi: number;
  success: number;
  failure: number;
}

/** Fully-resolved avatar configuration after layering defaults + user + project. */
export interface AvatarConfig {
  enabled: boolean;
  debug: boolean;
  /** Avatar width in terminal cells. */
  size: number;
  /** Words per second used to pace the talk animation. */
  readingSpeed: number;
  /** Hide the widget when the terminal is narrower than this (columns). */
  hideBelow: number;
  /** How long (ms) an LLM-triggered emotion overlay holds before resuming activity state. */
  emoteHoldMs: number;
  holdDuration: HoldDuration;
  /** Random `[min, max]` (ms) range between idle blinks / think swaps. */
  blinkInterval: [number, number];
  /** Interval (ms) between talk mouth-frame changes. */
  talkTickMs: number;
  /** Frame cycle interval (ms) for read/write/tool animations. */
  cycleMs: number;
  /** Image protocol override; `auto` detects from the environment. */
  render: 'auto' | Protocol;
  /** Collapse the kaomoji (ASCII) widget to a single `face | tool tally` line. Ignored in image modes. */
  compact: boolean;
  emotes: EmoteMapping[];
}
