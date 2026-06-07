/**
 * Pure lorebook timing / selection for the `roleplay` extension.
 *
 * Plain keyword matching ({@link ./match.ts}) decides which lore entries
 * *could* fire this turn. This module layers SillyTavern's "timed effects"
 * and inclusion-group selection on top so World Info feels organic instead
 * of firing every time a keyword appears:
 *
 *   - `delay`       - an entry is ineligible until turn >= `delay`.
 *   - `probability` - on a fresh activation it fires only `probability`%
 *                     of the time (100 = always).
 *   - `sticky`      - once fired it stays active for the next `sticky`
 *                     turns without a re-match (and without re-rolling
 *                     probability).
 *   - `cooldown`    - after its active window ends it cannot fire again
 *                     for `cooldown` turns.
 *   - `group`       - among entries that fired this turn sharing a
 *                     non-empty group, only ONE survives, chosen by a
 *                     `groupWeight`-weighted random pick.
 *
 * State per entry is two turn numbers, `{ stickyUntil, cooldownUntil }`,
 * both set once at a fresh fire to span the whole sticky+cooldown window -
 * so a carry turn needs no expiry bookkeeping, it just checks
 * `stickyUntil > turn`. Turns are a monotonic counter the caller owns.
 *
 * Determinism: all randomness comes from the injected `rng`. Draw order
 * is fixed - probability rolls in entry order first, then one group pick
 * per contested group in sorted group-name order - so tests with a
 * scripted rng are stable. No pi imports.
 */

import type { LoreMeta } from './store.ts';

/** Per-entry timing state carried across turns. `0` means "never armed". */
export interface TimingState {
  /** Entry is force-active (sticky carry) while `turn < stickyUntil`. */
  stickyUntil: number;
  /** Entry cannot freshly fire while `turn < cooldownUntil`. */
  cooldownUntil: number;
}

/** One lore entry presented to the timing pass for the current turn. */
export interface TimingEntry {
  id: string;
  meta: LoreMeta;
  /** Did this entry's keywords fire this turn (from `matchLore`)? */
  matched: boolean;
}

export interface TimingResult {
  /** Ids that survive timing + group selection, in input order. */
  fired: string[];
  /** Next-turn state for every entry that has a non-default state. */
  nextState: Record<string, TimingState>;
}

const ZERO: TimingState = { stickyUntil: 0, cooldownUntil: 0 };

/** Whether a freshly-eligible entry wins its probability roll. */
function rollProbability(probability: number, rng: () => number): boolean {
  if (probability >= 100) return true;
  if (probability <= 0) return false;
  return rng() * 100 < probability;
}

/**
 * Resolve timing + inclusion-group selection for one turn.
 *
 * Pure: never mutates `prior`. Returns the surviving entry ids plus the
 * next-turn state (only entries with a non-default state are included, to
 * keep the map small).
 */
export function applyTiming(
  entries: readonly TimingEntry[],
  turn: number,
  prior: Readonly<Record<string, TimingState>>,
  rng: () => number,
): TimingResult {
  // Pass 1: per-entry fire decision + tentative next state (entry order, so
  // probability draws are deterministic).
  const decisions = new Map<string, { fires: boolean; state: TimingState }>();
  for (const { id, meta, matched } of entries) {
    const st = prior[id] ?? ZERO;
    let fires = false;
    let next: TimingState = { stickyUntil: st.stickyUntil, cooldownUntil: st.cooldownUntil };

    if (turn < meta.delay) {
      fires = false;
    } else if (st.stickyUntil > turn) {
      // Sticky carry: stay active, keep the window untouched.
      fires = true;
    } else if (turn >= st.cooldownUntil && (matched || meta.constant)) {
      fires = rollProbability(meta.probability, rng);
      if (fires && (meta.sticky > 0 || meta.cooldown > 0)) {
        const stickyUntil = turn + meta.sticky + 1;
        next = { stickyUntil, cooldownUntil: stickyUntil + meta.cooldown };
      }
    }
    decisions.set(id, { fires, state: next });
  }

  // Pass 2: inclusion groups - among fired members of a group keep one,
  // weighted by groupWeight. Losers revert to their prior state (they did
  // not really fire, so they must not arm sticky/cooldown).
  const groups = new Map<string, string[]>();
  for (const { id, meta } of entries) {
    const decision = decisions.get(id);
    if (!decision?.fires || meta.group.length === 0) continue;
    const members = groups.get(meta.group) ?? [];
    members.push(id);
    groups.set(meta.group, members);
  }
  const metaById = new Map(entries.map((e) => [e.id, e.meta]));
  for (const groupName of [...groups.keys()].sort()) {
    const members = groups.get(groupName) ?? [];
    if (members.length < 2) continue;
    const weights = members.map((id) => Math.max(0, metaById.get(id)?.groupWeight ?? 0));
    const total = weights.reduce((a, b) => a + b, 0);
    let winner = members[0];
    if (total > 0) {
      let r = rng() * total;
      for (let i = 0; i < members.length; i += 1) {
        r -= weights[i];
        if (r < 0) {
          winner = members[i];
          break;
        }
      }
    }
    for (const id of members) {
      if (id === winner) continue;
      decisions.set(id, { fires: false, state: prior[id] ?? ZERO });
    }
  }

  // Collect results in input order.
  const fired: string[] = [];
  const nextState: Record<string, TimingState> = {};
  for (const { id } of entries) {
    const decision = decisions.get(id);
    if (!decision) continue;
    if (decision.fires) fired.push(id);
    if (decision.state.stickyUntil !== 0 || decision.state.cooldownUntil !== 0) {
      nextState[id] = decision.state;
    }
  }
  return { fired, nextState };
}
