/**
 * Pure name-keyed character-fold selection for the roleplay scene block.
 *
 * No pi imports - unit-testable under `vitest`.
 *
 * Gives `character` entries the same constant-vs-keyed injection that
 * `lore` entries already have (see {@link ./match.ts} / {@link ./timing.ts}),
 * so a relevant character's whole sheet is auto-injected into the
 * `## Roleplay scene` block instead of relying on the model firing a
 * `roleplay read` (a lookup it under-fires). Two tiers:
 *   - `pinned` characters fold every turn (the character-card analogue of
 *     a lore `constant` entry) - tier 1, "always present".
 *   - any character whose name / alias / extra trigger appears in the
 *     recent-message scan window folds in for the scene, kept alive by a
 *     sticky window so an NPC named on turn 1 but not turn 3 does not
 *     flicker out - tier 2, "on-stage transiently".
 *
 * This module deliberately reuses the lore machinery rather than
 * reinventing it: {@link hasKeyword} does the whole-word matching and
 * {@link applyTiming} does the sticky / cooldown / probability / delay
 * timing (a `CharacterMeta` is mapped onto the {@link LoreMeta}-shaped
 * timing input, with `pinned` playing the role of lore's `constant`).
 * Ranking + budget eviction stays in `composeSceneBlock` (the scene-block
 * renderer already owns a bounded greedy priority-eviction), so this
 * module only decides *which* characters are eligible to fold this turn.
 */

import { hasKeyword } from './match.ts';
import { emptyCharacterMeta, emptyLoreMeta, type CharacterMeta, type LoreMeta, type RoleplayEntry } from './store.ts';
import { applyTiming, type TimingState } from './timing.ts';

/** A character entry paired with its resolved (defaulted) fold metadata. */
interface CharacterCandidate {
  entry: RoleplayEntry;
  meta: CharacterMeta;
}

export interface CharacterFoldResult {
  /** Ids of the characters that fold this turn, in input order. */
  firedIds: string[];
  /** Ids that folded purely because they are `pinned` (subset of `firedIds`). */
  pinnedIds: string[];
  /** Next-turn timing state for the character-fold pass (feed back as `prior`). */
  nextTiming: Record<string, TimingState>;
}

export interface CharacterFoldOptions {
  /** Recent-message + current-prompt scan text; name/alias/trigger keys are matched against it. */
  scanText: string;
  /** Monotonic per-turn counter (shared with the lore timing clock). */
  turn: number;
  /** Prior character-fold timing state (from the previous turn's result). */
  priorTiming: Readonly<Record<string, TimingState>>;
  /** Injected randomness for probability / determinism in tests. */
  rng: () => number;
}

/** Resolve an entry's fold metadata, defaulting to the zero-config (name-only) meta. */
export function characterMeta(entry: RoleplayEntry): CharacterMeta {
  return entry.character ?? emptyCharacterMeta();
}

/**
 * The keys a character folds on: its own `name` (always, zero-config) plus
 * any authored `aliases` and extra `triggers`. Empty / duplicate keys are
 * dropped so the match scan stays cheap.
 */
export function characterKeys(entry: RoleplayEntry): string[] {
  const meta = characterMeta(entry);
  const keys = [entry.name, ...meta.aliases, ...meta.triggers].map((k) => k.trim()).filter((k) => k.length > 0);
  return [...new Set(keys)];
}

/** True when any of a character's keys appears (whole-word) in the scan text. */
export function characterMatches(entry: RoleplayEntry, scanText: string): boolean {
  return characterKeys(entry).some((k) => hasKeyword(scanText, k));
}

/**
 * Map a {@link CharacterMeta} onto the {@link LoreMeta}-shaped timing input
 * {@link applyTiming} expects. `pinned` becomes lore's `constant`
 * (always-fire); the group / secondary-key knobs stay at their inert
 * defaults (characters don't use inclusion groups). Kept private so the
 * timing coupling stays in one place.
 */
function timingMeta(meta: CharacterMeta): LoreMeta {
  return {
    ...emptyLoreMeta(),
    constant: meta.pinned,
    order: meta.order,
    probability: meta.probability,
    sticky: meta.sticky,
    cooldown: meta.cooldown,
    delay: meta.delay,
  };
}

/**
 * Decide which `character` entries fold into the scene this turn. Non-
 * character entries are ignored. Pinned characters fold every turn; other
 * characters fold when a key matches `scanText`, and a prior fold is kept
 * alive by its sticky window. Timing (sticky / cooldown / probability /
 * delay) is delegated to {@link applyTiming}. Pure: never mutates
 * `priorTiming`.
 */
export function planCharacterFold(entries: readonly RoleplayEntry[], opts: CharacterFoldOptions): CharacterFoldResult {
  const candidates: CharacterCandidate[] = entries
    .filter((e) => e.kind === 'character')
    .map((entry) => ({ entry, meta: characterMeta(entry) }));

  const timed = applyTiming(
    candidates.map(({ entry, meta }) => ({
      id: entry.id,
      meta: timingMeta(meta),
      matched: characterMatches(entry, opts.scanText),
    })),
    opts.turn,
    opts.priorTiming,
    opts.rng,
  );

  const firedSet = new Set(timed.fired);
  const pinnedIds = candidates.filter((c) => c.meta.pinned && firedSet.has(c.entry.id)).map((c) => c.entry.id);
  return { firedIds: timed.fired, pinnedIds, nextTiming: timed.nextState };
}
