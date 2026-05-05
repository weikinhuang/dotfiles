/**
 * Live-updating {@link RunBudget} wrapper for the deep-research
 * pipeline.
 *
 * The pure helpers in `research-budget.ts` describe a RunBudget
 * (per-phase cost + wall-clock caps) and a `trackPhase` decorator
 * that wraps one phase's async work, measures it, and appends a
 * `warn` entry to `journal.md` on overrun. That decorator model is
 * a perfect fit for a freshly-refactored pipeline where each phase
 * is a single callable — but the current deep-research pipeline
 * emits observability via a `PhaseEvent` stream rather than
 * exposing per-phase awaitables, and the long-lived parent session
 * straddles multiple phases (planner → self-crit → synth → merge →
 * refine). Wrapping each phase with `trackPhase` would require
 * threading callbacks through the pipeline internals.
 *
 * This module gives the extension a lighter-weight path:
 *
 *   1. Build a `RunBudget` from the caps baked into the extension
 *      (generous USD + wall-clock defaults).
 *   2. Wrap it in a {@link LiveBudget} whose `observePhaseEvent`
 *      consumes the same `PhaseEvent` stream the statusline
 *      reducer already watches. Phase transitions close the
 *      outgoing phase (adding its wall-clock to the budget and
 *      firing overrun warnings) and open the incoming one.
 *   3. Hand a `PhaseTracker` to every cost-hook / subagent spawn
 *      so per-assistant-turn cost deltas land in the right
 *      phase's accumulator — either a phase known at the call
 *      site (`trackerFor('fanout')`) or the current phase
 *      inferred from observed events (`currentPhaseTracker`, used
 *      for the long-lived parent session).
 *   4. Call `appendSummary()` once the pipeline is done / errored
 *      to write a single `[step] cost report` journal entry with
 *      the per-phase + total breakdown.
 *
 * The module stays pure: no pi imports, `now()` is injectable for
 * tests, and `journalPath` is a plain string. Overrun warnings
 * re-use the same "one warning per (phase, dimension)" semantics
 * as `research-budget.trackPhase` so callers migrating to that
 * decorator later see identical journal output.
 *
 * Boundaries:
 *
 *   - Not a replacement for `trackPhase`. Callers that own a
 *     single-shot async function should still prefer `trackPhase`
 *     because it reports per-invocation wall-clock precisely.
 *   - `currentPhaseTracker.addCost(usd)` is a no-op when no phase
 *     is currently open (the pipeline has not yet emitted a
 *     phase-mapping event). Guard against dropping early cost by
 *     making sure the pipeline emits `planning` before the first
 *     planner prompt (it does, see `runResearchPipeline`).
 *   - Phase mapping is conservative: events that do not clearly
 *     belong to a named phase (`fanout-progress`, `cost`, `done`,
 *     `error`, `start`) do not force a phase switch. `done` and
 *     `error` are the only terminal events — they close the
 *     current phase without opening a new one.
 */

import { type PhaseEvent } from './deep-research-statusline.ts';
import { type PhaseBudget, type PhaseTracker, type RunBudget } from './research-budget.ts';
import { appendJournal } from './research-journal.ts';

// ──────────────────────────────────────────────────────────────────────
// Phase taxonomy.
// ──────────────────────────────────────────────────────────────────────

/**
 * Canonical phase names used by `research-budget-live` for the
 * deep-research pipeline. Narrower than `StatuslineState.phase` so
 * the budget machinery doesn't carry UI-only states (`idle`,
 * `done`, `error`, `structural`) as separate cost buckets.
 *
 *   - `planner`    — planner agent + self-critic rewrite turns.
 *                    Same budget bucket because both run on the
 *                    parent session during the planning phase.
 *   - `plan-crit`  — planning-critic subagent spawn.
 *   - `fanout`     — web-researcher subagent spawns.
 *   - `synth`      — per-section synth turns on the parent session.
 *   - `merge`      — final merge turn on the parent session.
 *   - `refine`     — refinement synth turns (per review iteration).
 *   - `review`     — subjective critic subagent spawns. Structural
 *                    review is a deterministic bash check with no
 *                    LLM cost, so it does not get its own bucket.
 */
export type BudgetPhase = 'planner' | 'plan-crit' | 'fanout' | 'synth' | 'merge' | 'refine' | 'review';

/**
 * Generous per-phase caps used by the production deep-research
 * extension. These are advisory: `trackPhase` / LiveBudget only
 * log a `warn` entry when a phase blows through its cap — nothing
 * is aborted.
 *
 * Numbers calibrated against a claude-haiku fanout run spanning
 * 6 sub-questions with the web-researcher agent + a subjective
 * critic iteration. A claude-opus run or a pathological fanout
 * should exceed these and surface a warning so the user notices.
 */
export const DEFAULT_BUDGET_PHASES: readonly PhaseBudget[] = [
  { name: 'planner', maxCostUsd: 0.5, maxWallClockSec: 60 },
  { name: 'plan-crit', maxCostUsd: 0.5, maxWallClockSec: 60 },
  { name: 'fanout', maxCostUsd: 3.0, maxWallClockSec: 600 },
  { name: 'synth', maxCostUsd: 2.0, maxWallClockSec: 300 },
  { name: 'merge', maxCostUsd: 0.5, maxWallClockSec: 120 },
  { name: 'refine', maxCostUsd: 1.0, maxWallClockSec: 300 },
  { name: 'review', maxCostUsd: 2.0, maxWallClockSec: 300 },
] as const;

/**
 * Map a `PhaseEvent.kind` to the budget phase it contributes to,
 * or `null` when the event does not imply a phase change
 * (`start` / `done` / `error` / `cost` / `fanout-progress` /
 * `synth-progress`).
 */
export function phaseEventToBudgetName(kind: PhaseEvent['kind']): BudgetPhase | null {
  switch (kind) {
    case 'planning':
    case 'self-crit':
      return 'planner';
    case 'plan-crit':
      return 'plan-crit';
    case 'fanout-start':
      return 'fanout';
    case 'synth-start':
      return 'synth';
    case 'merge':
      return 'merge';
    case 'structural':
    case 'subjective':
      return 'review';
    default:
      return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// LiveBudget.
// ──────────────────────────────────────────────────────────────────────

export interface LiveBudgetSnapshot {
  totalCostUsd: number;
  totalWallClockSec: number;
  perPhase: Record<string, { costUsd: number; wallClockSec: number }>;
  /**
   * Current open phase (or `null` before the pipeline emits its
   * first phase-mapping event, and after a terminal `done` /
   * `error` event has closed it).
   */
  currentPhase: BudgetPhase | null;
}

export interface LiveBudget {
  /** Feed this into the same `onPhase` chain the statusline consumes. */
  observePhaseEvent(event: PhaseEvent): void;
  /**
   * Tracker whose `addCost` lands on the currently-open phase.
   * Use for the long-lived parent session — its assistant turns
   * span multiple phases, so the correct bucket depends on when
   * the turn lands.
   */
  readonly currentPhaseTracker: PhaseTracker;
  /**
   * Tracker bound to a specific phase. Use for subagent spawns
   * whose phase is known at the call site (fanout workers →
   * `'fanout'`, subjective critic → `'review'`).
   */
  trackerFor(phase: BudgetPhase): PhaseTracker;
  /**
   * Set the journal path used for overrun warnings + the final
   * summary. Lazy because the extension does not know the
   * `runRoot` until the planner has written `plan.json`.
   */
  setJournalPath(journalPath: string): void;
  /**
   * Close the current phase and append a single `cost report`
   * entry to the journal summarising per-phase + total cost +
   * wall-clock. No-op when no journal path is set.
   */
  appendSummary(): void;
  /** Synchronous snapshot, safe to read mid-run (e.g. for UI). */
  snapshot(): LiveBudgetSnapshot;
}

export interface CreateLiveBudgetOpts {
  budget: RunBudget;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

/**
 * Build a LiveBudget wrapping the caller-supplied `RunBudget`.
 *
 * The RunBudget's `phases` list determines which names are
 * honored by `trackerFor`; unknown names still accept `addCost`
 * calls (they bump `totalCostUsd`) but are not overrun-checked
 * because there is no cap to compare against. The production
 * extension always passes {@link DEFAULT_BUDGET_PHASES}, so this
 * only matters for tests / follow-up consumers.
 */
export function createLiveBudget(opts: CreateLiveBudgetOpts): LiveBudget {
  const now = opts.now ?? ((): number => Date.now());
  const budget = opts.budget;

  let currentPhase: BudgetPhase | null = null;
  let currentPhaseStartMs: number | null = null;

  const recordWallClock = (phase: BudgetPhase, startMs: number): void => {
    const elapsedSec = Math.max(0, (now() - startMs) / 1000);
    budget.perPhaseWallClockSec[phase] = (budget.perPhaseWallClockSec[phase] ?? 0) + elapsedSec;
    budget.totalWallClockSec += elapsedSec;
  };

  const logOverruns = (phase: PhaseBudget): void => {
    const phaseCost = budget.perPhaseCostUsd[phase.name] ?? 0;
    const phaseWall = budget.perPhaseWallClockSec[phase.name] ?? 0;

    const costKey = `${phase.name}:cost`;
    if (phaseCost > phase.maxCostUsd && !budget.overrunLogged.has(costKey)) {
      budget.overrunLogged.add(costKey);
      if (budget.journalPath) {
        try {
          appendJournal(budget.journalPath, {
            level: 'warn',
            heading: `Phase "${phase.name}" exceeded cost cap`,
            body: `spent ${phaseCost.toFixed(6)} USD / cap ${phase.maxCostUsd.toFixed(6)} USD`,
          });
        } catch {
          /* swallow — journaling is best-effort */
        }
      }
    }

    const wallKey = `${phase.name}:wall`;
    if (phaseWall > phase.maxWallClockSec && !budget.overrunLogged.has(wallKey)) {
      budget.overrunLogged.add(wallKey);
      if (budget.journalPath) {
        try {
          appendJournal(budget.journalPath, {
            level: 'warn',
            heading: `Phase "${phase.name}" exceeded wall-clock cap`,
            body: `spent ${phaseWall.toFixed(3)}s / cap ${phase.maxWallClockSec.toFixed(3)}s`,
          });
        } catch {
          /* swallow */
        }
      }
    }
  };

  const closeCurrent = (): void => {
    if (!currentPhase || currentPhaseStartMs === null) return;
    recordWallClock(currentPhase, currentPhaseStartMs);
    const declared = budget.phases.find((p) => p.name === currentPhase);
    if (declared) logOverruns(declared);
    currentPhase = null;
    currentPhaseStartMs = null;
  };

  const openPhase = (name: BudgetPhase): void => {
    if (currentPhase === name) return; // idempotent — repeated event for the same phase
    closeCurrent();
    currentPhase = name;
    currentPhaseStartMs = now();
  };

  const addCostRaw = (phase: string, usd: number): void => {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return;
    budget.perPhaseCostUsd[phase] = (budget.perPhaseCostUsd[phase] ?? 0) + usd;
    budget.totalCostUsd += usd;
  };

  const currentPhaseTracker: PhaseTracker = {
    addCost(usd: number): void {
      if (!currentPhase) return;
      addCostRaw(currentPhase, usd);
    },
    get costUsd(): number {
      if (!currentPhase) return 0;
      return budget.perPhaseCostUsd[currentPhase] ?? 0;
    },
  };

  return {
    observePhaseEvent(event: PhaseEvent): void {
      if (event.kind === 'done' || event.kind === 'error') {
        closeCurrent();
        return;
      }
      const name = phaseEventToBudgetName(event.kind);
      if (name) openPhase(name);
    },

    currentPhaseTracker,

    trackerFor(phase: BudgetPhase): PhaseTracker {
      return {
        addCost(usd: number): void {
          addCostRaw(phase, usd);
        },
        get costUsd(): number {
          return budget.perPhaseCostUsd[phase] ?? 0;
        },
      };
    },

    setJournalPath(journalPath: string): void {
      budget.journalPath = journalPath;
    },

    appendSummary(): void {
      closeCurrent();
      if (!budget.journalPath) return;
      const lines = budget.phases.map((p) => {
        const c = budget.perPhaseCostUsd[p.name] ?? 0;
        const w = budget.perPhaseWallClockSec[p.name] ?? 0;
        return `phase=${p.name} spent=${c.toFixed(6)} USD wall=${w.toFixed(2)}s`;
      });
      lines.push('');
      lines.push(`total=${budget.totalCostUsd.toFixed(6)} USD wall=${budget.totalWallClockSec.toFixed(2)}s`);
      try {
        appendJournal(budget.journalPath, {
          level: 'step',
          heading: 'cost report',
          body: lines.join('\n'),
        });
      } catch {
        /* swallow */
      }
    },

    snapshot(): LiveBudgetSnapshot {
      const perPhase: Record<string, { costUsd: number; wallClockSec: number }> = {};
      for (const p of budget.phases) {
        perPhase[p.name] = {
          costUsd: budget.perPhaseCostUsd[p.name] ?? 0,
          wallClockSec: budget.perPhaseWallClockSec[p.name] ?? 0,
        };
      }
      return {
        totalCostUsd: budget.totalCostUsd,
        totalWallClockSec: budget.totalWallClockSec,
        perPhase,
        currentPhase,
      };
    },
  };
}
