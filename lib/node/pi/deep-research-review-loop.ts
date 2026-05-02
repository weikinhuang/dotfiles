/**
 * Phase-4 review loop for `/research`: two-stage structural + critic
 * review over `report.md`, with "structure wins" override and
 * best-so-far on budget exhaustion.
 *
 * Design:
 *
 *   The iteration-loop extension's public `check` tool surface
 *   drives verdict dispatch (declare → accept → run → close) for
 *   both stages. This module, however, stays pure: the two
 *   verdict producers are injected as `runStructural` / `runCritic`
 *   so the spec can feed scripted verdicts without spawning real
 *   processes or subagents. The production adapter in
 *   `config/pi/extensions/deep-research.ts` wires them through the
 *   same underlying primitives (`iteration-loop-check-bash.ts`,
 *   `iteration-loop-check-critic.ts`) the tool uses, so behavior is
 *   identical — this is "via its tool surface" at the primitive
 *   level rather than re-invoking the tool dispatcher from inside
 *   another extension (pi does not expose a direct tool-invocation
 *   API for peers).
 *
 * Algorithm:
 *
 *   1. For each iteration (up to `maxIter`):
 *      a. Run structural. If fail:
 *         - Snapshot the report for best-so-far (score 0.0 on
 *           structural fail since the contract is binary).
 *         - Emit a structural-targeted refinement nudge. If we
 *           have iterations left, `refineReport` is invoked and
 *           we loop. Else we return budget-exhausted.
 *      b. Structural passed. Run critic.
 *         - On critic approve, re-run structural as a sanity
 *           check. If structural now fails, emit the
 *           `structural-override` outcome — "structure wins" over
 *           the critic's approval. This is the regression test
 *           path (the critic's verdict does not rescue a
 *           structurally-broken report).
 *         - On critic approve + structural still passes, return
 *           `passed`.
 *         - On critic reject, snapshot for best-so-far (carrying
 *           the critic's score), emit a subjective-rubric nudge,
 *           and loop if iterations remain.
 *
 *   Cross-stage budget is a single counter (`iterations` used).
 *   Structural and critic failures both consume one unit.
 *   `maxIter = 1` + first structural fail → budget-exhausted with
 *   the iter-1 snapshot as best-so-far. That's the acceptance-
 *   criterion path ("max-iterations to 1 in the test").
 *
 * Why the explicit re-check after critic approve?
 *
 *   The Phase-4 failure-mode we are guarding against is:
 *
 *     "a structurally-broken report with an approving critic is
 *      overridden to a failure verdict by the structural stage"
 *
 *   In production the structural check MUST pass before the
 *   critic is even invoked, so the natural path cannot produce
 *   this disagreement. But subjective refinements between
 *   iterations can break structure (e.g. synth rewrites a
 *   paragraph and drops a footnote). The re-check catches that
 *   drift and honors the plan's "structure wins" decision
 *   without needing the refinement path to preserve structure
 *   perfectly.
 *
 * No pi imports.
 */

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteFile, ensureDirSync } from './atomic-write.ts';
import { type StructuralCheckResult, type StructuralFailure } from './deep-research-structural-check.ts';
import { type Issue, type Verdict } from './iteration-loop-schema.ts';
import { paths } from './research-paths.ts';

// ──────────────────────────────────────────────────────────────────────
// Public types.
// ──────────────────────────────────────────────────────────────────────

/**
 * Injected by tests and the production extension to produce one
 * structural verdict per iteration. Errors propagate — the review
 * loop surfaces them as `{ kind: 'error', error }` outcomes.
 */
export type StructuralRunner = (opts: { iteration: number }) => Promise<StructuralCheckResult>;

/**
 * Injected to produce one critic verdict per iteration once
 * structural has passed.
 */
export type CriticRunner = (opts: { iteration: number }) => Promise<Verdict>;

/**
 * Invoked between iterations to refine the report against the
 * failure just observed. The refiner is expected to mutate the
 * on-disk `report.md` in place; if it can't, it returns
 * `{ ok: false, error }` and the review loop returns `{ kind: 'error' }`.
 */
export interface RefinementRequest {
  /** Which stage failed this iteration. */
  stage: 'structural' | 'subjective';
  /** Human-readable nudge summarizing the failures. Suitable for the synth prompt. */
  nudge: string;
  /** Populated on `stage === 'structural'`. */
  structural?: readonly StructuralFailure[];
  /** Populated on `stage === 'subjective'`. */
  critic?: Verdict;
  /** 0-indexed iteration that just failed (the refinement is for the NEXT one). */
  iteration: number;
}

export type RefinementRunner = (req: RefinementRequest) => Promise<{ ok: true } | { ok: false; error: string }>;

/**
 * Best-so-far pointer used by budget-exhaustion paths. The snapshot
 * file on disk is written by the review loop itself (not by the
 * refiner), so callers can surface it to the user at the end.
 */
export interface ReviewSnapshot {
  iteration: number;
  score: number;
  approved: boolean;
  /** Absolute path under `<runRoot>/snapshots/review/iter-NNN.md`. */
  snapshotPath: string;
  /** Which stage produced this best-so-far candidate. */
  stage: 'structural' | 'subjective';
}

/**
 * Terminal outcome of the review loop. Mirrors the plan's
 * acceptance-criteria shapes so the extension can branch cleanly
 * on `kind` for the journal entry and the user-facing notification.
 */
export type ReviewLoopOutcome =
  | {
      kind: 'passed';
      iterations: number;
      reportPath: string;
      critic: Verdict;
      structural: StructuralCheckResult;
    }
  | {
      kind: 'budget-exhausted';
      /**
       * Which stage the loop was in when budget ran out. `structural`
       * means the final iteration's structural check failed;
       * `subjective` means structural passed but the critic rejected
       * on the final iteration.
       */
      stage: 'structural' | 'subjective';
      iterations: number;
      bestSoFar: ReviewSnapshot | null;
      /** Most recent structural verdict (always populated — at least one ran). */
      lastStructural: StructuralCheckResult;
      /** Most recent critic verdict, if the critic ran at least once. */
      lastCritic: Verdict | null;
    }
  | {
      /**
       * Critic approved but the re-run structural check regressed.
       * Returned even when iterations remain — the failure is not a
       * refinement problem; it's a consistency problem between the
       * two stages.
       */
      kind: 'structural-override';
      iterations: number;
      structural: StructuralCheckResult;
      critic: Verdict;
    }
  | {
      /**
       * A runner or refiner threw / returned an error. The loop
       * aborts rather than swallowing — the caller decides whether
       * to escalate or fall back to best-so-far from a prior run.
       */
      kind: 'error';
      error: string;
      iterations: number;
      bestSoFar: ReviewSnapshot | null;
    };

export interface ReviewLoopDeps {
  /** Run root (`<cwd>/research/<slug>/`). `report.md` lives at `paths(runRoot).report`. */
  runRoot: string;
  /** Produces a structural verdict per iteration. */
  runStructural: StructuralRunner;
  /** Produces a critic verdict per iteration, invoked only after structural passes. */
  runCritic: CriticRunner;
  /** Modifies `report.md` in place between iterations. */
  refineReport: RefinementRunner;
  /**
   * Max cross-stage iterations. Default 3 (per the plan's
   * "≤ 3 refinements total across both stages"). Tests pass
   * `maxIter = 1` to exercise budget exhaustion in a single pass.
   */
  maxIter?: number;
  /** Test-inject clock for deterministic journal timestamps (unused in v1 besides potential future extensions). */
  now?: () => Date;
  /** Abort fused with per-runner signals. */
  signal?: AbortSignal;
}

// ──────────────────────────────────────────────────────────────────────
// Nudge builders.
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a plain-text refinement nudge from a structural check's
 * failure list. Keeps each failure on its own line with the check
 * id as a prefix so the synthesizer can pattern-match on specific
 * structural gaps.
 */
export function buildStructuralNudge(result: StructuralCheckResult): string {
  if (result.failures.length === 0) return '';
  const lines: string[] = [];
  lines.push('The structural review rejected the report. Fix every issue below and preserve all passing checks:');
  for (const f of result.failures) {
    const loc = f.location ? ` — at ${f.location}` : '';
    lines.push(`  - [${f.id}] ${f.message}${loc}`);
  }
  lines.push(
    'Do not invent new sources to satisfy footnote resolution — use only URLs already present in sources/. ' +
      'If a citation cannot be sourced from the store, remove the footnote marker and rewrite the sentence.',
  );
  return lines.join('\n');
}

/**
 * Build a subjective refinement nudge from a critic's verdict. The
 * structural items are excluded (the critic doesn't judge them —
 * they're already deterministic), so every issue here is a
 * subjective-rubric gap.
 */
export function buildSubjectiveNudge(verdict: Verdict): string {
  // An approved verdict never needs a refinement nudge; return
  // the empty string so callers can compose without a guard.
  if (verdict.approved) return '';
  if (verdict.issues.length === 0 && !verdict.summary) return '';
  const lines: string[] = [];
  const scoreLabel = verdict.score.toFixed(2);
  lines.push(`The subjective critic rejected the report (score ${scoreLabel}).`);
  if (verdict.summary) lines.push(`Critic summary: ${verdict.summary}`);
  if (verdict.issues.length > 0) {
    lines.push('Fix every issue below while preserving the structural contract:');
    for (const issue of verdict.issues) {
      const loc = issue.location ? ` — at ${issue.location}` : '';
      lines.push(`  - [${issue.severity}] ${issue.description}${loc}`);
    }
  }
  lines.push('Preserve every footnote marker and source citation; the structural check will re-verify.');
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Snapshotting.
// ──────────────────────────────────────────────────────────────────────

/**
 * Per-iteration snapshot dir: `<runRoot>/snapshots/review/`. One
 * file per iteration, suffixed by stage so a single iteration can
 * hold both a structural-fail snapshot and a subjective-fail one.
 */
function snapshotPath(runRoot: string, iteration: number, stage: ReviewSnapshot['stage']): string {
  const dir = `${paths(runRoot).snapshots}/review`;
  const padded = iteration.toString().padStart(3, '0');
  return `${dir}/iter-${padded}-${stage}.md`;
}

/**
 * Copy the current `report.md` into a per-iteration snapshot file.
 * Returns the snapshot path or null if the report is missing
 * (which would make "best-so-far" meaningless for this iteration
 * anyway).
 */
function snapshotReport(
  runRoot: string,
  iteration: number,
  stage: ReviewSnapshot['stage'],
): { path: string; body: string } | null {
  const report = paths(runRoot).report;
  if (!existsSync(report)) return null;
  let body: string;
  try {
    body = readFileSync(report, 'utf8');
  } catch {
    return null;
  }
  const out = snapshotPath(runRoot, iteration, stage);
  ensureDirSync(`${paths(runRoot).snapshots}/review`);
  atomicWriteFile(out, body);
  return { path: out, body };
}

/**
 * Selector honoring the iteration-loop's "approved beats
 * higher-scored-but-not-approved" rule — a structurally-passing
 * but subjectively-rejected report (score 0.7) outranks an
 * unapproved structural-fail snapshot (score 0.0). Ties broken by
 * iteration recency.
 */
function selectBest(prev: ReviewSnapshot | null, next: ReviewSnapshot): ReviewSnapshot {
  if (!prev) return next;
  if (prev.approved && !next.approved) return prev;
  if (!prev.approved && next.approved) return next;
  if (next.score > prev.score) return next;
  if (next.score === prev.score && next.iteration > prev.iteration) return next;
  return prev;
}

// ──────────────────────────────────────────────────────────────────────
// Public entry point.
// ──────────────────────────────────────────────────────────────────────

/**
 * Drive the two-stage review loop. See module docstring for the
 * full algorithm. The function is pure modulo the `runStructural`
 * / `runCritic` / `refineReport` injections and the disk writes
 * for snapshots.
 */
export async function runReviewLoop(deps: ReviewLoopDeps): Promise<ReviewLoopOutcome> {
  const maxIter = Math.max(1, Math.floor(deps.maxIter ?? 3));
  let bestSoFar: ReviewSnapshot | null = null;
  let lastCritic: Verdict | null = null;

  for (let iter = 1; iter <= maxIter; iter += 1) {
    // ── Structural stage ──────────────────────────────────────
    let structural: StructuralCheckResult;
    try {
      structural = await deps.runStructural({ iteration: iter });
    } catch (e) {
      return {
        kind: 'error',
        error: `structural runner threw on iter ${iter}: ${(e as Error).message}`,
        iterations: iter - 1,
        bestSoFar,
      };
    }
    if (deps.signal?.aborted) {
      return {
        kind: 'error',
        error: `review loop aborted after structural iter ${iter}`,
        iterations: iter,
        bestSoFar,
      };
    }

    if (!structural.ok) {
      const snap = snapshotReport(deps.runRoot, iter, 'structural');
      if (snap) {
        bestSoFar = selectBest(bestSoFar, {
          iteration: iter,
          score: 0,
          approved: false,
          snapshotPath: snap.path,
          stage: 'structural',
        });
      }
      if (iter >= maxIter) {
        return {
          kind: 'budget-exhausted',
          stage: 'structural',
          iterations: iter,
          bestSoFar,
          lastStructural: structural,
          lastCritic,
        };
      }
      const refineResult = await deps.refineReport({
        stage: 'structural',
        nudge: buildStructuralNudge(structural),
        structural: structural.failures,
        iteration: iter,
      });
      if (!refineResult.ok) {
        return {
          kind: 'error',
          error: `structural refinement failed on iter ${iter}: ${refineResult.error}`,
          iterations: iter,
          bestSoFar,
        };
      }
      continue;
    }

    // ── Critic stage ──────────────────────────────────────────
    let critic: Verdict;
    try {
      critic = await deps.runCritic({ iteration: iter });
    } catch (e) {
      return {
        kind: 'error',
        error: `critic runner threw on iter ${iter}: ${(e as Error).message}`,
        iterations: iter - 1,
        bestSoFar,
      };
    }
    lastCritic = critic;
    if (deps.signal?.aborted) {
      return {
        kind: 'error',
        error: `review loop aborted after critic iter ${iter}`,
        iterations: iter,
        bestSoFar,
      };
    }

    if (critic.approved) {
      // Structure-wins defense: re-verify structural after an
      // approve, in case the subjective refinements from prior
      // iterations drifted the structure.
      let reStructural: StructuralCheckResult;
      try {
        reStructural = await deps.runStructural({ iteration: iter });
      } catch (e) {
        return {
          kind: 'error',
          error: `structural re-check threw on iter ${iter}: ${(e as Error).message}`,
          iterations: iter,
          bestSoFar,
        };
      }
      if (!reStructural.ok) {
        return {
          kind: 'structural-override',
          iterations: iter,
          structural: reStructural,
          critic,
        };
      }
      return {
        kind: 'passed',
        iterations: iter,
        reportPath: paths(deps.runRoot).report,
        critic,
        structural: reStructural,
      };
    }

    // Critic rejected. Snapshot carries the critic's own score
    // so a later best-so-far selection prefers "structural-pass
    // + critic-0.7" over "structural-fail + score-0.0".
    const snap = snapshotReport(deps.runRoot, iter, 'subjective');
    if (snap) {
      bestSoFar = selectBest(bestSoFar, {
        iteration: iter,
        score: critic.score,
        approved: false,
        snapshotPath: snap.path,
        stage: 'subjective',
      });
    }
    if (iter >= maxIter) {
      return {
        kind: 'budget-exhausted',
        stage: 'subjective',
        iterations: iter,
        bestSoFar,
        lastStructural: structural,
        lastCritic: critic,
      };
    }
    const refineResult = await deps.refineReport({
      stage: 'subjective',
      nudge: buildSubjectiveNudge(critic),
      critic,
      iteration: iter,
    });
    if (!refineResult.ok) {
      return {
        kind: 'error',
        error: `subjective refinement failed on iter ${iter}: ${refineResult.error}`,
        iterations: iter,
        bestSoFar,
      };
    }
  }

  // Unreachable: the loop returns inside each branch. Guard to
  // keep TS happy and fail loudly if somebody adds a `break`.
  return {
    kind: 'error',
    error: 'runReviewLoop exited the iteration loop without returning',
    iterations: maxIter,
    bestSoFar,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Utility: Issue → compact structured log line. Used by callers that
// log verdicts to the journal.
// ──────────────────────────────────────────────────────────────────────

/**
 * Compact one-line renderer for a critic {@link Issue}. Callers
 * (the extension's journal path, tests) use this to produce
 * log-friendly strings.
 */
export function formatIssue(issue: Issue): string {
  const loc = issue.location ? ` [${issue.location}]` : '';
  return `[${issue.severity}] ${issue.description}${loc}`;
}
