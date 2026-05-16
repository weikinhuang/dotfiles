/**
 * Session-branch reducer for the iteration-loop extension.
 *
 * Mirrors the `todo-reducer.ts` / `scratchpad-reducer.ts` shape. Each
 * tool call's post-action `IterationState` is emitted as BOTH the
 * `toolResult.details` payload AND a mirrored
 * `customType: 'iteration-state'` session entry. On `session_start` /
 * `session_tree`, the reducer scans newest-to-oldest for the most
 * recent valid snapshot and returns it (or `null` - there is no
 * "active loop" until the user accepts a spec).
 *
 * Action handlers are pure `(state, args) -> ActionResult`. The
 * extension's `check` tool dispatches to them, persists the result's
 * state, and mirrors it into a custom entry.
 *
 * Actions:
 *
 *   - `actAccept` - seed a fresh state when the user accepts a draft.
 *     No prior state needed.
 *   - `actRecordEdit` - increment `editsSinceLastCheck`. Called from
 *     the extension's `after_tool_call` hook when a write/edit
 *     targets the declared artifact.
 *   - `actRun` - record a completed iteration. Consumes a Verdict
 *     and run metadata; returns the new state.
 *   - `actClose` - mark the loop terminated with a stop reason.
 *
 * No pi imports.
 */

import {
  type ActionError,
  type ActionResult as GenericActionResult,
  type ActionSuccess as GenericActionSuccess,
  type BranchEntry as GenericBranchEntry,
  findLatestStateInBranch,
  stateFromEntryGeneric,
} from './branch-state.ts';
import { selectBestSoFar, normalizeScore } from './iteration-loop-budget.ts';
import {
  type BestSoFar,
  cloneIterationState,
  emptyIterationState,
  type HistoryEntry,
  isIterationStateShape,
  isStopReason,
  type IterationState,
  type StopReason,
  type Verdict,
} from './iteration-loop-schema.ts';

// ──────────────────────────────────────────────────────────────────────
// Branch-state plumbing
// ──────────────────────────────────────────────────────────────────────

/** Stable identifiers referenced by the extension and tests. */
export const ITERATION_TOOL_NAME = 'check';
export const ITERATION_CUSTOM_TYPE = 'iteration-state';

export type BranchEntry = GenericBranchEntry;

/**
 * Extract state from a single branch entry or return null. See
 * `stateFromEntryGeneric` for the dual-shape acceptance rules.
 */
export function stateFromEntry(entry: BranchEntry): IterationState | null {
  return stateFromEntryGeneric(
    entry,
    ITERATION_TOOL_NAME,
    ITERATION_CUSTOM_TYPE,
    isIterationStateShape,
    cloneIterationState,
  );
}

/**
 * Walk a branch newest-to-oldest; return the most recent valid state
 * or `null`. Callers decide what "null" means - typically "no loop is
 * active, fall back to empty-until-accept".
 */
export function reduceBranch(branch: readonly BranchEntry[]): IterationState | null {
  return findLatestStateInBranch(
    branch,
    ITERATION_TOOL_NAME,
    ITERATION_CUSTOM_TYPE,
    isIterationStateShape,
    cloneIterationState,
  );
}

// ──────────────────────────────────────────────────────────────────────
// Action result types
// ──────────────────────────────────────────────────────────────────────

export type ActionSuccess = GenericActionSuccess<IterationState>;
export type { ActionError };
export type ActionResult = GenericActionResult<IterationState>;

// ──────────────────────────────────────────────────────────────────────
// actAccept - seed state at the moment of user acceptance.
// ──────────────────────────────────────────────────────────────────────

export interface AcceptArgs {
  task: string;
  acceptedAt: string; // ISO8601
}

/**
 * Called when the user accepts a draft. Initializes a fresh state
 * rooted at the given timestamp. If a state already exists for this
 * task (it shouldn't - the extension enforces single-task in v1), we
 * overwrite it: accepting a new draft means "start over."
 */
export function actAccept(_prev: IterationState | null, args: AcceptArgs): ActionResult {
  if (!args.task || typeof args.task !== 'string') {
    return { ok: false, error: 'accept requires non-empty `task`' };
  }
  if (!args.acceptedAt || typeof args.acceptedAt !== 'string') {
    return { ok: false, error: 'accept requires `acceptedAt` ISO8601 timestamp' };
  }
  if (!Number.isFinite(Date.parse(args.acceptedAt))) {
    return { ok: false, error: `accept requires a parseable ISO8601 \`acceptedAt\` (got "${args.acceptedAt}")` };
  }
  const fresh = emptyIterationState(args.task, args.acceptedAt);
  return { ok: true, state: fresh, summary: `Accepted task "${args.task}" - ready for iteration 1.` };
}

// ──────────────────────────────────────────────────────────────────────
// actRecordEdit - bump edits-since-check counter.
// ──────────────────────────────────────────────────────────────────────

/**
 * Called from `after_tool_call` when a write/edit targets the
 * declared artifact. Returns an error (not a state change) when the
 * loop is already terminated - a stopped loop shouldn't accrue edit
 * tracking.
 */
export function actRecordEdit(prev: IterationState | null): ActionResult {
  if (!prev) return { ok: false, error: 'no active loop' };
  if (prev.stopReason) {
    return { ok: false, error: `loop already terminated (${prev.stopReason})` };
  }
  const next = cloneIterationState(prev);
  next.editsSinceLastCheck += 1;
  return {
    ok: true,
    state: next,
    summary: `Edit recorded (${next.editsSinceLastCheck} since last check).`,
  };
}

// ──────────────────────────────────────────────────────────────────────
// actRun - record a completed iteration.
// ──────────────────────────────────────────────────────────────────────

function defaultSummary(v: Verdict): string {
  if (v.approved) return 'approved';
  if (v.issues.length === 0) return 'not approved';
  const first = v.issues[0];
  const rest = v.issues.length > 1 ? ` (+${v.issues.length - 1} more)` : '';
  return `not approved - [${first.severity}] ${first.description}${rest}`;
}

export interface RunArgs {
  verdict: Verdict;
  /** Per-run USD cost delta (0 for bash checks). */
  costDeltaUsd: number;
  /** 1-indexed assistant turn number in which this run completed. */
  turnNumber: number;
  /** The snapshot written for this iteration, if one could be taken. */
  snapshot: { path: string; hash: string } | null;
  /** Stop reason classified by the extension (null = keep going). */
  stopReason: StopReason | null;
  /** ISO8601 timestamp of the run. */
  ranAt: string;
}

/**
 * Append a completed iteration to history. The caller (extension) has
 * already classified stopReason via `computeStopReason`, so we simply
 * record it onto state and the prompt layer picks it up.
 *
 * Best-so-far tracking:
 *   - Approved verdict with a snapshot always wins outright (sets
 *     bestSoFar AND stopReason='passed').
 *   - Non-approved verdicts with a snapshot win iff `selectBestSoFar`
 *     says they beat the current bestSoFar.
 *   - Without a snapshot, bestSoFar can't be updated (we have no
 *     path/hash to record) - the bestSoFar from earlier iterations is
 *     preserved.
 */
export function actRun(prev: IterationState | null, args: RunArgs): ActionResult {
  if (!prev) return { ok: false, error: 'no active loop (accept a draft first)' };
  if (prev.stopReason) {
    return { ok: false, error: `loop already terminated (${prev.stopReason}) - cannot record another run` };
  }
  if (!args.verdict) return { ok: false, error: 'run requires `verdict`' };
  if (typeof args.costDeltaUsd !== 'number' || !Number.isFinite(args.costDeltaUsd) || args.costDeltaUsd < 0) {
    return { ok: false, error: 'run requires non-negative `costDeltaUsd`' };
  }

  const next = cloneIterationState(prev);
  next.iteration += 1;
  next.editsSinceLastCheck = 0;
  next.lastCheckTurn = args.turnNumber;
  next.lastVerdict = {
    approved: args.verdict.approved,
    score: normalizeScore(args.verdict),
    issues: args.verdict.issues.map((i) => ({ ...i })),
    summary: args.verdict.summary,
    raw: args.verdict.raw,
  };
  next.costUsd = prev.costUsd + args.costDeltaUsd;

  // Best-so-far - only updatable when we have a snapshot path/hash to record.
  if (args.snapshot) {
    const candidate: BestSoFar = {
      iteration: next.iteration,
      score: next.lastVerdict.score,
      approved: args.verdict.approved,
      snapshotPath: args.snapshot.path,
      artifactHash: args.snapshot.hash,
    };
    // Normalize older bestSoFar entries that predate the `approved`
    // field - default missing approval to `false` so the selector
    // treats them as not-approved (safe: only way to clobber is a
    // strictly-better candidate).
    const currentBest =
      prev.bestSoFar && typeof (prev.bestSoFar as Partial<BestSoFar>).approved !== 'boolean'
        ? { ...prev.bestSoFar, approved: false }
        : prev.bestSoFar;
    next.bestSoFar = selectBestSoFar(currentBest, candidate);
  }

  const historyEntry: HistoryEntry = {
    iteration: next.iteration,
    score: next.lastVerdict.score,
    approved: args.verdict.approved,
    summary: args.verdict.summary ?? defaultSummary(args.verdict),
    stopReason: args.stopReason,
    ranAt: args.ranAt,
  };
  next.history.push(historyEntry);
  next.stopReason = args.stopReason;

  const verdictWord = args.verdict.approved ? 'approved' : 'not approved';
  const stopTail = args.stopReason ? ` (stopped: ${args.stopReason})` : '';
  return {
    ok: true,
    state: next,
    summary: `Iter ${next.iteration}: ${verdictWord} - score ${next.lastVerdict.score.toFixed(2)}${stopTail}`,
  };
}

// ──────────────────────────────────────────────────────────────────────
// actClose - explicit termination.
// ──────────────────────────────────────────────────────────────────────

export interface CloseArgs {
  reason: StopReason;
}

/**
 * Explicitly close the loop. No-op when already closed (idempotent -
 * re-closing keeps the original stop reason).
 */
export function actClose(prev: IterationState | null, args: CloseArgs): ActionResult {
  if (!prev) return { ok: false, error: 'no active loop' };
  if (prev.stopReason) {
    return {
      ok: true,
      state: cloneIterationState(prev),
      summary: `Already closed (${prev.stopReason}).`,
    };
  }
  if (!isStopReason(args.reason)) {
    return { ok: false, error: `invalid close reason "${String(args.reason)}"` };
  }
  const next = cloneIterationState(prev);
  next.stopReason = args.reason;
  return { ok: true, state: next, summary: `Closed (${args.reason}).` };
}
