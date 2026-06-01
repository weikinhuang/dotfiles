/**
 * Pure emote-set resolution helpers for the `avatar` extension.
 *
 * Covers model -> set glob resolution, classification of a set's
 * subdirectories into activity states vs emotion overlays, and the
 * random / weighted frame pickers (with an injectable RNG so tests are
 * deterministic). Filesystem discovery itself (readdir / base64) lives
 * in the extension shell.
 */

import type { ActivityState, EmoteMapping } from './types.ts';
import { ACTIVITY_STATES } from './types.ts';

const ACTIVITY_STATE_SET: ReadonlySet<string> = new Set(ACTIVITY_STATES);

/** Whether `name` is one of the automatic activity states. */
export function isActivityState(name: string): name is ActivityState {
  return ACTIVITY_STATE_SET.has(name);
}

/**
 * Compile a glob `pattern` (`*` = any run, `?` = single char) into a
 * case-insensitive anchored regex for matching against a model id.
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export interface ResolvedEmoteSet {
  /** The winning emote-set name (`default` when nothing matched). */
  set: string;
  /** Extra kaomoji sets to layer on top of `set`, in order (last wins). */
  overlays: string[];
  /** True when more than one non-`*` pattern matched (caller may warn). */
  ambiguous: boolean;
}

/**
 * Resolve which emote set to use for `modelId`. Last match wins, so
 * higher-priority config layers (appended later) override lower ones.
 * The winning mapping's `overlays` (if any) are layered on top of its
 * base set. The catch-all `*` does not count toward ambiguity.
 */
export function resolveEmoteSet(modelId: string, emotes: readonly EmoteMapping[]): ResolvedEmoteSet {
  let matched: string | null = null;
  let overlays: string[] = [];
  let specificMatches = 0;
  for (const entry of emotes) {
    if (globToRegex(entry.model).test(modelId)) {
      if (entry.model !== '*') specificMatches++;
      matched = entry['emote-set'];
      overlays = entry.overlays ?? [];
    }
  }
  return { set: matched ?? 'default', overlays, ambiguous: specificMatches > 1 };
}

export interface ClassifiedStates {
  /** Subdirs that are automatic activity states. */
  activities: ActivityState[];
  /** Subdirs that are emotion overlays (everything else). */
  emotions: string[];
}

/**
 * Split a set's subdirectory names into activity states and emotion
 * overlays. Any directory not in {@link ACTIVITY_STATES} is treated as
 * a named emotion (e.g. `happy`, `sad`). Emotions are sorted for a
 * stable prompt-vocabulary order.
 */
export function classifyStateDirs(dirNames: readonly string[]): ClassifiedStates {
  const activities: ActivityState[] = [];
  const emotions: string[] = [];
  for (const name of dirNames) {
    if (isActivityState(name)) {
      activities.push(name);
    } else {
      emotions.push(name);
    }
  }
  emotions.sort();
  return { activities, emotions };
}

/** Pick a uniformly-random element, or `null` for an empty list. */
export function pickRandom<T>(items: readonly T[], rng: () => number = Math.random): T | null {
  if (items.length === 0) return null;
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items[index];
}

/**
 * Pick a key from `weights` proportional to its weight. Returns `null`
 * when the map is empty or all weights are non-positive.
 */
export function pickWeighted(weights: Record<string, number>, rng: () => number = Math.random): string | null {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let r = rng() * total;
  for (const [file, weight] of entries) {
    r -= weight;
    if (r <= 0) return file;
  }
  return entries[entries.length - 1][0];
}
