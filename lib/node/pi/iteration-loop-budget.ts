/**
 * Stop-reason calculator, best-so-far selector, and fixpoint
 * detector for the iteration-loop.
 *
 * Pure functions over (CheckSpec, IterationState, Verdict). No disk
 * I/O, no pi imports - unit-testable in isolation.
 *
 * Stop-reason precedence (first match wins):
 *
 *   1. `user-closed`         - set by the extension on `check close`;
 *                              not computed here.
 *   2. `passed`              - the latest verdict was approved.
 *   3. `fixpoint`            - two consecutive iterations produced
 *                              the same artifact hash AND the latest
 *                              verdict is not approved (no point
 *                              iterating further - the actor's
 *                              edits aren't changing anything).
 *   4. `budget-cost`         - cumulative cost ≥ maxCostUsd.
 *   5. `budget-iter`         - iteration count ≥ maxIter.
 *   6. `wall-clock`          - elapsed seconds since `startedAt` ≥
 *                              wallClockSeconds.
 *   7. `null`                - keep going.
 *
 * The ordering matters: `passed` outranks every budget cap because a
 * verdict approved *on the last iteration budget allowed* is still a
 * pass, not an exhaustion. Similarly `fixpoint` outranks budgets
 * because it's a harder signal ("more iterations won't help") than
 * "you've spent enough" - surfacing it gives the user a better
 * diagnostic.
 */

import {
  type BestSoFar,
  type CheckSpec,
  type IterationState,
  resolveBudget,
  type StopReason,
  type Verdict,
} from './iteration-loop-schema.ts';

// ──────────────────────────────────────────────────────────────────────
// Fixpoint detection
// ──────────────────────────────────────────────────────────────────────

/**
 * A fixpoint is when the current artifact hash equals the previous
 * iteration's artifact hash. We pull the previous hash from
 * `bestSoFar` (if it's the immediate predecessor) OR from the tail
 * of `history` - but history entries don't carry the snapshot hash,
 * so this function takes the prior hash as an argument. Callers
 * (the extension) pass it explicitly after looking it up via storage.
 *
 * Returns true iff `prevHash` is non-null and equals `currentHash`.
 */
export function isFixpoint(prevHash: string | null, currentHash: string): boolean {
  return prevHash !== null && prevHash === currentHash;
}

// ──────────────────────────────────────────────────────────────────────
// Best-so-far selector
// ──────────────────────────────────────────────────────────────────────

/**
 * Decide whether `candidate` should replace `current` as the
 * best-so-far.
 *
 * Replacement rules, in order:
 *
 *   1. No current best           → candidate wins.
 *   2. Candidate approved and
 *      current not approved      → candidate wins.
 *   3. Both approved or both not → higher score wins.
 *   4. Tie on score              → later iteration wins (keeps the
 *                                  freshest snapshot as the tiebreaker
 *                                  so the user sees recent work).
 */
export function selectBestSoFar(current: BestSoFar | null, candidate: BestSoFar): BestSoFar {
  if (!current) return candidate;
  // Approved beats not-approved, full stop - the loop's goal is "find a
  // passing verdict", so a later-but-lower-scored approved iteration
  // is still strictly better than an earlier not-approved one.
  if (candidate.approved && !current.approved) return candidate;
  if (!candidate.approved && current.approved) return current;
  // Same approval status - higher score wins, ties go to the freshest
  // iteration so the user sees recent work.
  if (candidate.score > current.score) return candidate;
  if (candidate.score === current.score && candidate.iteration > current.iteration) return candidate;
  return current;
}

// ──────────────────────────────────────────────────────────────────────
// Stop-reason calculator
// ──────────────────────────────────────────────────────────────────────

export interface ComputeStopReasonInput {
  spec: CheckSpec;
  /**
   * Post-run state. `iteration` is the just-completed run's index
   * (1-indexed); `lastVerdict` is the verdict from that run;
   * `costUsd` includes that run's cost; `startedAt` is the loop's
   * start timestamp (ISO8601).
   */
  state: Pick<IterationState, 'iteration' | 'lastVerdict' | 'costUsd' | 'startedAt'>;
  /**
   * The artifact hash of the just-completed run's snapshot, if one
   * exists. Null when the run produced no snapshot (e.g. artifact
   * was missing on disk).
   */
  currentArtifactHash: string | null;
  /**
   * The artifact hash of the PRIOR run's snapshot, if any. Null on
   * the first run or when the prior snapshot was unreadable.
   */
  previousArtifactHash: string | null;
  /**
   * Current clock - injected for deterministic tests. Production
   * callers pass `() => new Date()` or `() => mockedDate`.
   */
  now: Date;
}

/**
 * Classify why the loop should stop after the just-completed run.
 * Returns null when iteration should continue.
 *
 * The caller is responsible for persisting the returned stop reason
 * onto `state.stopReason` so subsequent `check run` calls refuse
 * (we don't mutate here).
 */
export function computeStopReason(input: ComputeStopReasonInput): StopReason | null {
  const { spec, state, currentArtifactHash, previousArtifactHash, now } = input;
  const budget = resolveBudget(spec);

  // (1) user-closed is set externally. (2) passed.
  if (state.lastVerdict?.approved) return 'passed';

  // (3) fixpoint - only meaningful with two snapshots to compare.
  if (currentArtifactHash !== null && isFixpoint(previousArtifactHash, currentArtifactHash)) {
    return 'fixpoint';
  }

  // (4) cost cap - soft, but enforced.
  if (state.costUsd >= budget.maxCostUsd) return 'budget-cost';

  // (5) iteration cap.
  if (state.iteration >= budget.maxIter) return 'budget-iter';

  // (6) wall-clock cap.
  const startedMs = Date.parse(state.startedAt);
  if (Number.isFinite(startedMs)) {
    const elapsedSec = (now.getTime() - startedMs) / 1000;
    if (elapsedSec >= budget.wallClockSeconds) return 'wall-clock';
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Budget snapshot for the status-prompt injection
// ──────────────────────────────────────────────────────────────────────

export interface BudgetSnapshot {
  iterUsed: number;
  iterMax: number;
  costUsed: number;
  costMax: number;
  wallElapsedSec: number;
  wallMaxSec: number;
}

export function budgetSnapshot(spec: CheckSpec, state: IterationState, now: Date): BudgetSnapshot {
  const budget = resolveBudget(spec);
  const startedMs = Date.parse(state.startedAt);
  const elapsedSec = Number.isFinite(startedMs) ? (now.getTime() - startedMs) / 1000 : 0;
  return {
    iterUsed: state.iteration,
    iterMax: budget.maxIter,
    costUsed: state.costUsd,
    costMax: budget.maxCostUsd,
    wallElapsedSec: Math.max(0, Math.round(elapsedSec)),
    wallMaxSec: budget.wallClockSeconds,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Verdict scoring fallback
// ──────────────────────────────────────────────────────────────────────

/**
 * Normalize a verdict's score into [0, 1]. Bash checks return 0 or 1;
 * critic/diff may return NaN or out-of-range values if the LLM
 * misbehaves. Clamp defensively so best-so-far arithmetic stays sane.
 */
export function normalizeScore(v: Verdict): number {
  const s = v.score;
  if (!Number.isFinite(s)) return v.approved ? 1 : 0;
  if (s < 0) return 0;
  if (s > 1) return 1;
  return s;
}
