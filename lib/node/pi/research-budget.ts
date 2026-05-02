/**
 * Budget + stop-reason helpers for research runs.
 *
 * Thin wrapper over `lib/node/pi/iteration-loop-budget.ts` — the
 * iteration-loop already owns a tested implementation of
 * `computeStopReason` / `selectBestSoFar`, so research-core simply
 * re-exports them rather than re-implementing the semantics. Both
 * sibling plans (deep-research, autoresearch) consume the same
 * stop-reason enum, the same best-so-far comparator, and the same
 * per-run budget envelope; keeping the wrapper thin means a fix in
 * the iteration-loop lands in the research toolkit for free.
 *
 * What this module adds on top:
 *
 *   - `PhaseBudget` / `RunBudget`: a *per-phase* breakdown suited to
 *     multi-phase research pipelines (planner → fanout → synth →
 *     critic → …). The iteration-loop's budget is a single whole-run
 *     envelope; research pipelines want "the synth phase may use up
 *     to $0.02 and 60 seconds" with the envelope composed from
 *     per-phase caps.
 *   - `trackPhase(budget, phaseName, fn)`: wraps an async callback
 *     that performs one phase's work, measures its cost + wall-
 *     clock, accumulates totals into the budget, and appends a
 *     `warn` entry to the run's journal the first time a phase
 *     exceeds its cap. It does NOT abort the callback — the phase is
 *     allowed to complete; overruns are surfaced as diagnostics for
 *     the caller to decide what to do next (escalate, continue,
 *     quarantine). This mirrors how `iteration-loop-budget`'s stop-
 *     reason calculator is advisory: it reports exhaustion; it does
 *     not kill in-flight work.
 *
 * Intentional omissions:
 *
 *   - No hard cancellation. Cooperative cancellation is the caller's
 *     job (it owns the `AbortSignal` threaded into the underlying
 *     LLM / network call).
 *   - No provider-specific cost math. Callers report USD cost via
 *     the phase tracker; how that number is sourced (provider usage
 *     events, static model pricing, ...) is out of scope here.
 *   - No disk persistence for the running totals. The budget object
 *     is in-memory state for one run; disk-backed accounting lives
 *     in the consuming extension (deep-research / autoresearch) if
 *     it needs resume across pi restarts.
 *
 * No pi imports — takes a plain `journalPath` string so tests exercise
 * the journal hook without a pi runtime.
 */

import {
  budgetSnapshot,
  type BudgetSnapshot,
  type ComputeStopReasonInput,
  computeStopReason,
  isFixpoint,
  normalizeScore,
  selectBestSoFar,
} from './iteration-loop-budget.ts';
import { appendJournal } from './research-journal.ts';

// ──────────────────────────────────────────────────────────────────────
// Re-exports — keep the iteration-loop stop-reason machinery under
// research-friendly import paths so callers never have to reach past
// research-core into the iteration-loop internals.
// ──────────────────────────────────────────────────────────────────────

export {
  budgetSnapshot,
  type BudgetSnapshot,
  type ComputeStopReasonInput,
  computeStopReason,
  isFixpoint,
  normalizeScore,
  selectBestSoFar,
};

// ──────────────────────────────────────────────────────────────────────
// Per-phase budget shapes.
// ──────────────────────────────────────────────────────────────────────

/**
 * Declarative cap for one phase of a research pipeline.
 *
 *   - `name`            — free-form identifier ("planner", "synth",
 *                         "critic", "experiment-3"). Must be unique
 *                         within a `RunBudget.phases` list; the
 *                         factory validates uniqueness.
 *   - `maxCostUsd`      — soft USD cap. First overrun is logged as a
 *                         warning; subsequent overruns in the same
 *                         phase are NOT re-logged (noise reduction).
 *   - `maxWallClockSec` — soft wall-clock cap, measured per phase in
 *                         seconds. Independent of the cost cap —
 *                         either can fire its own overrun log.
 *
 * Both caps are non-negative finite numbers. The factory throws on
 * invalid values so callers can't accidentally ship `NaN` caps that
 * silently disable overrun detection.
 */
export interface PhaseBudget {
  name: string;
  maxCostUsd: number;
  maxWallClockSec: number;
}

/**
 * In-memory envelope holding per-phase caps + the running totals
 * `trackPhase` accumulates into. `perPhase*` maps are keyed by phase
 * name. `overrunLogged` records which (phaseName, dimension) pairs
 * have already produced a journal warning so repeated overruns
 * within one phase don't flood the journal.
 *
 * `journalPath` is optional: in unit tests the caller builds a
 * budget without a journal and inspects the running totals
 * directly. A production run passes the per-run `journal.md` path
 * so overruns surface alongside the rest of the pipeline log.
 */
export interface RunBudget {
  phases: PhaseBudget[];
  totalCostUsd: number;
  totalWallClockSec: number;
  perPhaseCostUsd: Record<string, number>;
  perPhaseWallClockSec: Record<string, number>;
  /**
   * `<phaseName>:cost` / `<phaseName>:wall` set once an overrun on
   * that dimension has been logged for that phase.
   */
  overrunLogged: Set<string>;
  /** Optional path to the run's `journal.md`. Unset ⇒ no journaling. */
  journalPath?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Factory.
// ──────────────────────────────────────────────────────────────────────

export interface CreateRunBudgetOpts {
  /**
   * Path to the run's journal.md. When set, overrun warnings are
   * appended there via `research-journal.appendJournal`. When unset,
   * overruns are tracked internally (`overrunLogged`) but not
   * surfaced — the caller can inspect the budget after the fact.
   */
  journalPath?: string;
}

function isValidCap(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Build a `RunBudget` from a list of phase caps. Validates each
 * phase's shape up-front so a misconfigured phase fails the
 * pipeline at setup, not in the middle of a run.
 */
export function createRunBudget(phases: PhaseBudget[], opts: CreateRunBudgetOpts = {}): RunBudget {
  const seen = new Set<string>();
  for (const p of phases) {
    if (typeof p.name !== 'string' || p.name.length === 0) {
      throw new TypeError(`createRunBudget: phase.name must be a non-empty string`);
    }
    if (seen.has(p.name)) {
      throw new TypeError(`createRunBudget: duplicate phase name "${p.name}"`);
    }
    seen.add(p.name);
    if (!isValidCap(p.maxCostUsd)) {
      throw new TypeError(`createRunBudget: phase "${p.name}" maxCostUsd must be a non-negative finite number`);
    }
    if (!isValidCap(p.maxWallClockSec)) {
      throw new TypeError(`createRunBudget: phase "${p.name}" maxWallClockSec must be a non-negative finite number`);
    }
  }

  return {
    // Copy the inputs so later mutation of the caller's array does
    // not stealth-mutate the budget.
    phases: phases.map((p) => ({ ...p })),
    totalCostUsd: 0,
    totalWallClockSec: 0,
    perPhaseCostUsd: {},
    perPhaseWallClockSec: {},
    overrunLogged: new Set<string>(),
    ...(opts.journalPath !== undefined ? { journalPath: opts.journalPath } : {}),
  };
}

// ──────────────────────────────────────────────────────────────────────
// trackPhase.
// ──────────────────────────────────────────────────────────────────────

/**
 * Handle passed to the phase callback so it can report intra-phase
 * USD cost incrementally. A phase that makes N LLM calls bumps
 * `addCost(call.usage.cost.total)` after each one; the accumulated
 * value is compared against the phase's `maxCostUsd` at phase end.
 *
 * `addCost` silently ignores non-finite or negative values so a
 * caller pulling cost out of a provider payload that omits it
 * (`undefined`) can call `addCost(undefined as any)` without a
 * guard. NaN / -1 / Infinity all no-op.
 */
export interface PhaseTracker {
  addCost: (usd: number) => void;
  /** Current accumulated cost within this phase invocation. */
  readonly costUsd: number;
}

export interface TrackPhaseOpts {
  /**
   * Clock injection for deterministic tests. Production callers
   * leave it unset and the helper uses `new Date()`.
   */
  now?: () => Date;
}

/**
 * Emit at most one warning per (phase, dimension) to avoid flooding
 * the journal when a long-running phase keeps ticking past its cap.
 * The caller who wants a louder signal watches `overrunLogged`.
 */
function logOverrunsOnce(budget: RunBudget, phase: PhaseBudget): void {
  const phaseCost = budget.perPhaseCostUsd[phase.name] ?? 0;
  const phaseWall = budget.perPhaseWallClockSec[phase.name] ?? 0;

  const costKey = `${phase.name}:cost`;
  if (phaseCost > phase.maxCostUsd && !budget.overrunLogged.has(costKey)) {
    budget.overrunLogged.add(costKey);
    if (budget.journalPath) {
      appendJournal(budget.journalPath, {
        level: 'warn',
        heading: `Phase "${phase.name}" exceeded cost cap`,
        body: `spent ${phaseCost.toFixed(6)} USD / cap ${phase.maxCostUsd.toFixed(6)} USD`,
      });
    }
  }

  const wallKey = `${phase.name}:wall`;
  if (phaseWall > phase.maxWallClockSec && !budget.overrunLogged.has(wallKey)) {
    budget.overrunLogged.add(wallKey);
    if (budget.journalPath) {
      appendJournal(budget.journalPath, {
        level: 'warn',
        heading: `Phase "${phase.name}" exceeded wall-clock cap`,
        body: `spent ${phaseWall.toFixed(3)}s / cap ${phase.maxWallClockSec.toFixed(3)}s`,
      });
    }
  }
}

/**
 * Run `fn` as the work of `phaseName`, accumulate its cost +
 * wall-clock into `budget`, and log a single warning per dimension
 * per phase when the phase's cap is exceeded.
 *
 * Behavior:
 *   - `phaseName` must resolve to a `PhaseBudget` in `budget.phases`
 *     (throws on unknown phase — a misnamed phase is always a bug).
 *   - The callback receives a `PhaseTracker`. Its `addCost` method
 *     is how the callback reports LLM or network cost incurred
 *     during the phase. If `fn` does not call `addCost`, only wall-
 *     clock accounting runs (and the cost-overrun log never fires).
 *   - The callback may be sync or async; both are awaited uniformly.
 *   - Wall-clock is measured as `now()` at entry vs. `now()` at exit
 *     (including the time spent inside a rejected promise). A
 *     thrown `fn` still records its wall-clock usage into the
 *     budget before re-throwing — a failed phase that ate the
 *     budget should be visible in the running totals.
 *   - Overrun warnings go to `budget.journalPath` (when set) via
 *     `research-journal.appendJournal` with level `warn`.
 *   - Returns whatever `fn` returns.
 */
export async function trackPhase<T>(
  budget: RunBudget,
  phaseName: string,
  fn: (tracker: PhaseTracker) => T | Promise<T>,
  opts: TrackPhaseOpts = {},
): Promise<T> {
  const phase = budget.phases.find((p) => p.name === phaseName);
  if (!phase) {
    throw new Error(`trackPhase: unknown phase "${phaseName}"`);
  }

  const now = opts.now ?? ((): Date => new Date());
  const startMs = now().getTime();

  let cost = 0;
  const tracker: PhaseTracker = {
    addCost(usd: number): void {
      if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return;
      cost += usd;
    },
    get costUsd(): number {
      return cost;
    },
  };

  const record = (): void => {
    const elapsedSec = Math.max(0, (now().getTime() - startMs) / 1000);
    budget.perPhaseCostUsd[phaseName] = (budget.perPhaseCostUsd[phaseName] ?? 0) + cost;
    budget.perPhaseWallClockSec[phaseName] = (budget.perPhaseWallClockSec[phaseName] ?? 0) + elapsedSec;
    budget.totalCostUsd += cost;
    budget.totalWallClockSec += elapsedSec;

    logOverrunsOnce(budget, phase);
  };

  try {
    const result = await fn(tracker);
    record();
    return result;
  } catch (err) {
    record();
    throw err;
  }
}
