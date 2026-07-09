/**
 * Runtime shape validators for the iteration-loop check kinds, verdict
 * payloads, and persisted state. Split out from `schema.ts` so callers
 * that only need the type aliases (or only need the guards) don't drag
 * the whole file in.
 *
 * Used by the reducer + storage layers to accept untrusted payloads:
 * session entries from older runs, on-disk JSON typed by hand, critic
 * subagent verdicts (which arrive as JSON the reducer must validate).
 *
 * Pure module: no `@earendil-works/*` imports. The numeric helpers are
 * re-implemented locally instead of pulling in a generic `is`-utility
 * file - keeps the boundary small and the guard semantics explicit
 * (e.g. `isScore` clamps to `[0, 1]` because verdict scores live in
 * that range; an unrelated future caller would not get a quietly
 * generalised version of `isScore`).
 */

import { isRecord } from '../shared.ts';
import type {
  BashCheckSpec,
  BashPassOn,
  BestSoFar,
  BudgetSpec,
  CheckKind,
  CheckSpec,
  CriticCheckSpec,
  HistoryEntry,
  IssueSeverity,
  Issue,
  IterationState,
  StopReason,
  Verdict,
} from './schema.ts';

// ──────────────────────────────────────────────────────────────────────
// Numeric primitives (private)
// ──────────────────────────────────────────────────────────────────────

function isNonNegativeFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isPositiveFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isScore(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function isIssueSeverity(v: unknown): v is IssueSeverity {
  return v === 'blocker' || v === 'major' || v === 'minor';
}

// ──────────────────────────────────────────────────────────────────────
// Public guards
// ──────────────────────────────────────────────────────────────────────

export function isStopReason(v: unknown): v is StopReason {
  return (
    v === 'passed' ||
    v === 'budget-iter' ||
    v === 'budget-cost' ||
    v === 'wall-clock' ||
    v === 'fixpoint' ||
    v === 'user-closed'
  );
}

export function isCheckKind(v: unknown): v is CheckKind {
  return v === 'bash' || v === 'critic';
}

export function isBashPassOn(v: unknown): v is BashPassOn {
  if (v === 'exit-zero') return true;
  if (typeof v !== 'string') return false;
  return v.startsWith('regex:') || v.startsWith('jq:');
}

export function isBudgetSpecShape(v: unknown): v is BudgetSpec {
  if (v === undefined) return true; // budget is optional on CheckSpec
  if (!isRecord(v)) return false;
  // Budgets must be POSITIVE, not merely non-negative: a `maxIter` of 0
  // (or a 0 cost / wall-clock cap) makes `computeStopReason` terminate
  // the loop on the very first tick, so a persisted 0/negative budget is
  // rejected rather than loaded as an insta-stop spec. `maxIter` is
  // additionally an integer.
  if (v.maxIter !== undefined && !isPositiveInteger(v.maxIter)) return false;
  if (v.maxCostUsd !== undefined && !isPositiveFiniteNumber(v.maxCostUsd)) return false;
  if (v.wallClockSeconds !== undefined && !isPositiveFiniteNumber(v.wallClockSeconds)) return false;
  return true;
}

export function isBashCheckSpecShape(v: unknown): v is BashCheckSpec {
  if (!isRecord(v)) return false;
  if (typeof v.cmd !== 'string' || v.cmd.length === 0) return false;
  if (v.passOn !== undefined && !isBashPassOn(v.passOn)) return false;
  if (v.workdir !== undefined && typeof v.workdir !== 'string') return false;
  if (v.timeoutMs !== undefined && !isNonNegativeFiniteNumber(v.timeoutMs)) return false;
  if (v.env !== undefined) {
    if (!isRecord(v.env)) return false;
    for (const k of Object.keys(v.env)) {
      if (typeof v.env[k] !== 'string') return false;
    }
  }
  return true;
}

export function isCriticCheckSpecShape(v: unknown): v is CriticCheckSpec {
  if (!isRecord(v)) return false;
  if (typeof v.rubric !== 'string' || v.rubric.length === 0) return false;
  if (v.agent !== undefined && typeof v.agent !== 'string') return false;
  if (v.modelOverride !== undefined && typeof v.modelOverride !== 'string') return false;
  return true;
}

export function isCheckSpecShape(v: unknown): v is CheckSpec {
  if (!isRecord(v)) return false;
  if (typeof v.task !== 'string' || v.task.length === 0) return false;
  if (!isCheckKind(v.kind)) return false;
  if (typeof v.artifact !== 'string' || v.artifact.length === 0) return false;
  if (typeof v.createdAt !== 'string') return false;
  if (v.acceptedAt !== undefined && typeof v.acceptedAt !== 'string') return false;
  if (!isBudgetSpecShape(v.budget)) return false;
  if (v.kind === 'bash') {
    if (!isBashCheckSpecShape(v.spec)) return false;
  } else if (v.kind === 'critic') {
    if (!isCriticCheckSpecShape(v.spec)) return false;
  } else {
    return false;
  }
  return true;
}

export function isIssueShape(v: unknown): v is Issue {
  if (!isRecord(v)) return false;
  if (!isIssueSeverity(v.severity)) return false;
  if (typeof v.description !== 'string' || v.description.length === 0) return false;
  if (v.location !== undefined && typeof v.location !== 'string') return false;
  return true;
}

export function isVerdictShape(v: unknown): v is Verdict {
  if (!isRecord(v)) return false;
  if (typeof v.approved !== 'boolean') return false;
  if (!isScore(v.score)) return false;
  if (!Array.isArray(v.issues)) return false;
  for (const issue of v.issues) {
    if (!isIssueShape(issue)) return false;
  }
  if (v.summary !== undefined && typeof v.summary !== 'string') return false;
  if (v.raw !== undefined && typeof v.raw !== 'string') return false;
  return true;
}

export function isBestSoFarShape(v: unknown): v is BestSoFar {
  if (!isRecord(v)) return false;
  if (!isNonNegativeInteger(v.iteration)) return false;
  if (!isScore(v.score)) return false;
  // Tolerate older state entries that predate the `approved` field by
  // defaulting to `false` on read (normalized by the reducer when it
  // rebuilds state). The selector then treats legacy bestSoFar entries
  // as "not approved," which is the safe default for comparisons.
  if (v.approved !== undefined && typeof v.approved !== 'boolean') return false;
  if (typeof v.snapshotPath !== 'string' || v.snapshotPath.length === 0) return false;
  if (typeof v.artifactHash !== 'string' || v.artifactHash.length === 0) return false;
  return true;
}

export function isHistoryEntryShape(v: unknown): v is HistoryEntry {
  if (!isRecord(v)) return false;
  if (!isNonNegativeInteger(v.iteration)) return false;
  if (!isScore(v.score)) return false;
  if (typeof v.approved !== 'boolean') return false;
  if (typeof v.summary !== 'string') return false;
  if (v.stopReason !== null && !isStopReason(v.stopReason)) return false;
  if (typeof v.ranAt !== 'string') return false;
  return true;
}

export function isIterationStateShape(v: unknown): v is IterationState {
  if (!isRecord(v)) return false;
  if (typeof v.task !== 'string' || v.task.length === 0) return false;
  if (!isNonNegativeInteger(v.iteration)) return false;
  if (!isNonNegativeInteger(v.editsSinceLastCheck)) return false;
  if (v.lastCheckTurn !== null && !isNonNegativeInteger(v.lastCheckTurn)) return false;
  if (v.lastVerdict !== null && !isVerdictShape(v.lastVerdict)) return false;
  if (v.bestSoFar !== null && !isBestSoFarShape(v.bestSoFar)) return false;
  if (!isNonNegativeFiniteNumber(v.costUsd)) return false;
  if (!Array.isArray(v.history)) return false;
  for (const entry of v.history) {
    if (!isHistoryEntryShape(entry)) return false;
  }
  if (v.stopReason !== null && !isStopReason(v.stopReason)) return false;
  if (typeof v.startedAt !== 'string') return false;
  return true;
}
