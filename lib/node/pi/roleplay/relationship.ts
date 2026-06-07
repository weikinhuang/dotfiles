/**
 * Pure relationship-decay math for the `roleplay` extension.
 *
 * A `relationship` record carries an `affinity` (0-100) plus an
 * `lastInteraction` ISO date. Affinity is the live, model-rewritten
 * warmth of a pair; left untouched it drifts back toward a neutral
 * baseline (a neglected bond cools; an old grudge softens). This module
 * computes that drift deterministically from wall-clock dates so the
 * extension shell can surface a "current" affinity without persisting a
 * timer.
 *
 * Convention (absolute-dated, toward-baseline):
 *   - Decay always moves affinity TOWARD `baseline`, never past it. A
 *     value above baseline erodes downward; a value below baseline warms
 *     upward; a value already at baseline never moves.
 *   - Magnitude is `decayPerDay * daysElapsed`, where `daysElapsed` is
 *     the whole-day gap between `lastInteraction` and `now`.
 *   - No decay is applied when `lastInteraction` is missing, unparseable,
 *     or in the future (clock skew / a record dated ahead): the stored
 *     affinity is returned verbatim.
 *
 * No pi imports - unit-tested directly.
 */

/** Milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

export interface DecayOptions {
  /** Affinity points pulled toward `baseline` per elapsed day. */
  decayPerDay: number;
  /** Neutral resting affinity decay converges to. */
  baseline: number;
}

/** The minimal relationship shape the decay math reads. */
export interface DecayInput {
  affinity: number;
  /** ISO date (`YYYY-MM-DD`) of the last interaction. */
  lastInteraction?: string;
}

/**
 * Whole days elapsed between `lastInteraction` and `now`. Returns `null`
 * when `lastInteraction` is absent, unparseable, or after `now`. Uses
 * `floor` so a partial day counts as no decay until the day completes.
 */
export function daysElapsed(lastInteraction: string | undefined, now: Date): number | null {
  if (lastInteraction === undefined || lastInteraction.trim().length === 0) return null;
  const then = Date.parse(lastInteraction);
  if (!Number.isFinite(then)) return null;
  const diffMs = now.getTime() - then;
  if (diffMs < 0) return null;
  return Math.floor(diffMs / MS_PER_DAY);
}

/**
 * Current affinity after decay toward `baseline`. Pure: never mutates
 * the input. Clamps the result to `[0, 100]` and never overshoots the
 * baseline (a downward decay stops at baseline, an upward one stops at
 * baseline).
 */
export function decayAffinity(input: DecayInput, now: Date, opts: DecayOptions): number {
  const stored = Math.min(100, Math.max(0, input.affinity));
  const days = daysElapsed(input.lastInteraction, now);
  if (days === null || days === 0) return stored;

  const rate = Math.max(0, opts.decayPerDay);
  if (rate === 0) return stored;
  const baseline = Math.min(100, Math.max(0, opts.baseline));

  const drift = rate * days;
  if (stored > baseline) return Math.max(baseline, stored - drift);
  if (stored < baseline) return Math.min(baseline, stored + drift);
  return stored;
}

/**
 * One-line human summary of a relationship's current standing, e.g.
 * `affinity 64/100 (stored 72, neutral 50), trust: high`. `current` is
 * the decayed value from {@link decayAffinity}; pass the stored affinity
 * when no decay applies. Omits the drift parenthetical when `current`
 * equals `stored`.
 */
export function formatRelationshipLine(stored: number, current: number, trust: string, baseline: number): string {
  const rounded = Math.round(current);
  const parts = [`affinity ${rounded}/100`];
  if (rounded !== Math.round(stored)) {
    parts[0] += ` (stored ${Math.round(stored)}, neutral ${Math.round(baseline)})`;
  }
  if (trust.trim().length > 0) parts.push(`trust: ${trust.trim()}`);
  return parts.join(', ');
}
