/* eslint-disable no-use-before-define */

/**
 * Extension-side wiring for the Phase-4 deep-research review loop.
 *
 * Orchestrates the post-pipeline review:
 *
 *   1. Gate on consent. First-time users get a one-line
 *      "auto-accepting checks from now on" notice; subsequent
 *      runs proceed silently. The consent flag lives under the
 *      user's global memory dir (see `deep-research-review-config`).
 *   2. Record the spec for each check via the iteration-loop
 *      storage helpers — `writeDraft` then `acceptDraft` — so the
 *      task shows up in `/check list` and survives pi restarts.
 *      This is the "declare / accept" half of the tool surface.
 *   3. Call `runReviewLoop` with `runStructural` /
 *      `runCritic` / `refineReport` wired by the caller.
 *   4. Render the terminal outcome into a human-readable
 *      summary suitable for `ctx.ui.notify`.
 *
 * Test seam:
 *
 *   The heavy-lifting wiring (subagent spawn, bash-check exec,
 *   synth re-run) lives behind the three injected runners so a
 *   vitest spec can drive this helper with scripted verdicts.
 *   That's exactly how `deep-research-review-loop.spec.ts` already
 *   exercises the core algorithm; the extension wiring adds the
 *   consent / task-state / notify layer on top.
 *
 * No pi imports — this module is unit-testable under vitest and
 * the production extension consumes it with real pi deps bound.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { readConsent, recordConsent, type ReviewConsentOpts } from './deep-research-review-config.ts';
import {
  classifyReviewCloseness,
  REVIEW_RESUME_BUMP,
  runReviewLoop,
  type CriticRunner,
  type RefinementRunner,
  type ReviewLoopOutcome,
  type StructuralRunner,
} from './deep-research-review-loop.ts';
import { type BashCheckSpec, type CheckSpec, type CriticCheckSpec } from './iteration-loop-schema.ts';
import { acceptDraft, archiveTask, writeDraft } from './iteration-loop-storage.ts';
import { appendJournal } from './research-journal.ts';
import { paths } from './research-paths.ts';
import { findStubbedSections } from './research-resume.ts';
import { formatStubbedReviewSummary } from './research-stub-hint.ts';

// ──────────────────────────────────────────────────────────────────────
// Task constants.
// ──────────────────────────────────────────────────────────────────────

/** Iteration-loop task name for the structural stage. */
export const STRUCTURAL_TASK = 'deep-research-structural';
/** Iteration-loop task name for the subjective critic stage. */
export const SUBJECTIVE_TASK = 'deep-research-subjective';

// ──────────────────────────────────────────────────────────────────────
// Types.
// ──────────────────────────────────────────────────────────────────────

export interface ReviewWireDeps {
  /** Agent cwd — where `.pi/checks/` lives. */
  cwd: string;
  /** Deep-research run root — where `report.md` + `rubric-*.md` live. */
  runRoot: string;
  /**
   * Subjective rubric body (contents of `rubric-subjective.md`) —
   * materialized upstream by the synth phase, read once and
   * threaded in here so the critic spec carries it.
   */
  rubricSubjective: string;
  /** Bash command the structural iteration-loop check would run. Used for the informational spec only. */
  structuralBashCmd: string;
  /** Injected review-loop runners. */
  runStructural: StructuralRunner;
  runCritic: CriticRunner;
  refineReport: RefinementRunner;
  /** Max cross-stage iterations. Default 3 per the plan. */
  maxIter?: number;
  /**
   * Iteration label for the first iteration. Forwarded to
   * {@link runReviewLoop}; resume flows set this to `N+1` after
   * counting prior `snapshots/review/iter-NNN-*.md` files.
   */
  startIteration?: number;
  /** Signal fused with each runner. */
  signal?: AbortSignal;
  /** Injected clock (tests). */
  now?: () => Date;
  /** Consent storage overrides (tests). */
  consent?: ReviewConsentOpts;
  /** Hook for user-visible messaging (tests pass a spy). */
  notify?: (message: string, level: 'info' | 'warning' | 'error') => void;
  /** Override for the iteration-loop task name pair (tests). */
  taskNames?: { structural: string; subjective: string };
}

export interface ReviewWireResult {
  /** Terminal review-loop outcome. */
  outcome: ReviewLoopOutcome;
  /** Consent was recorded (or already present) by the time the loop ran. */
  consented: boolean;
  /** True iff this run was the first time consent was recorded. */
  firstTimeConsent: boolean;
  /** Summary string already handed to `notify`; re-exposed for journaling. */
  summary: string;
  /** Final level the summary was notified at. */
  level: 'info' | 'warning' | 'error';
}

// ──────────────────────────────────────────────────────────────────────
// Public entry point.
// ──────────────────────────────────────────────────────────────────────

/**
 * Run the review loop against the just-synthesized report. Drives:
 *
 *   - Consent bootstrap.
 *   - Iteration-loop declare + accept for both checks (on-disk
 *     state lives under `<cwd>/.pi/checks/`).
 *   - `runReviewLoop` with the injected runners.
 *   - Archive both tasks on loop termination.
 *   - Format + notify.
 *
 * Errors in the declare/accept plumbing are journaled and then
 * swallowed so review still attempts to run — the in-memory
 * runners are the authoritative source of the verdict.
 */
export async function runDeepResearchReview(deps: ReviewWireDeps): Promise<ReviewWireResult> {
  const notify = deps.notify ?? noopNotify;
  const taskNames = deps.taskNames ?? { structural: STRUCTURAL_TASK, subjective: SUBJECTIVE_TASK };
  const journalPath = paths(deps.runRoot).journal;
  const now = deps.now ?? ((): Date => new Date());
  const reportPath = paths(deps.runRoot).report;

  // ── 0. Stubbed short-circuit ──────────────────────────────
  // A freshly-rendered `report.md` that still contains
  // `[section unavailable: …]` sub-question stubs cannot be
  // rescued by the review loop: structural already exempts
  // stubbed sections from its citation rule (so iterations
  // wouldn't wedge on them), and `refineMergeOnly` cannot add
  // missing findings. Running the loop would burn up to
  // `maxIter` turns before the extension's post-loop notify
  // surfaces the re-fetch hint. Detect stubs at entry instead,
  // journal the skip, and return a terminal `stubbed` outcome
  // the caller renders with the same recovery-command shape
  // the post-loop hint uses.
  const stubbedSections = findStubbedSections(reportPath);
  if (stubbedSections.length > 0) {
    const summary = formatStubbedReviewSummary(deps.runRoot, stubbedSections);
    safeJournal(
      journalPath,
      `review short-circuit: ${stubbedSections.length} stubbed section(s) \u2014 skipping loop`,
      summary,
      'warn',
    );
    notify(summary, 'warning');
    return {
      outcome: { kind: 'stubbed', stubbed: stubbedSections, reportPath },
      // Consent is neither needed nor recorded on the short-
      // circuit path — the loop never ran, so there's nothing
      // to auto-accept. The next non-stubbed review will pick
      // up the bootstrap the first time the loop actually runs.
      consented: false,
      firstTimeConsent: false,
      summary,
      level: 'warning',
    };
  }

  // ── 1. Consent gate ────────────────────────────────────────
  const consentOpts: ReviewConsentOpts = deps.consent ?? {};
  let priorConsent = readConsent(consentOpts);
  let firstTimeConsent = false;
  if (!priorConsent.consented) {
    firstTimeConsent = true;
    priorConsent = recordConsent({ ...consentOpts, ...(deps.now ? { now: deps.now } : {}) });
    notify(
      '/research: first-time review-loop consent recorded — future runs will auto-accept the structural + subjective iteration-loop checks without prompting.',
      'info',
    );
    safeJournal(journalPath, 'review consent recorded', priorConsent.at ?? now().toISOString());
  }

  // ── 2. Declare both iteration-loop checks ─────────────────
  // The specs are informational — the pi runtime doesn't invoke
  // them (we call the injected runners directly), but surfacing
  // them through `/check list` keeps the tool surface coherent
  // with what the plan promises. We best-effort through failures
  // since the review loop must still run even if the iteration-
  // loop storage refuses a write.
  const structuralSpec = buildStructuralSpec({
    task: taskNames.structural,
    reportPath: paths(deps.runRoot).report,
    bashCmd: deps.structuralBashCmd,
    maxIter: deps.maxIter ?? 3,
    createdAt: now().toISOString(),
  });
  const subjectiveSpec = buildSubjectiveSpec({
    task: taskNames.subjective,
    reportPath: paths(deps.runRoot).report,
    rubric: deps.rubricSubjective,
    maxIter: deps.maxIter ?? 3,
    createdAt: now().toISOString(),
  });

  for (const spec of [structuralSpec, subjectiveSpec] as const) {
    const write = writeDraft(deps.cwd, spec);
    if (!write.ok) {
      safeJournal(journalPath, `iteration-loop declare failed (${spec.task})`, write.error);
      continue;
    }
    const accepted = acceptDraft(deps.cwd, spec.task, now().toISOString());
    if (!accepted.ok) {
      safeJournal(journalPath, `iteration-loop accept failed (${spec.task})`, accepted.error);
    }
  }

  // ── 3. Drive the review loop ──────────────────────────────
  let outcome: ReviewLoopOutcome;
  try {
    outcome = await runReviewLoop({
      ...(deps.startIteration !== undefined ? { startIteration: deps.startIteration } : {}),
      runRoot: deps.runRoot,
      runStructural: deps.runStructural,
      runCritic: deps.runCritic,
      refineReport: deps.refineReport,
      ...(deps.maxIter !== undefined ? { maxIter: deps.maxIter } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
  } catch (e) {
    const summary = `/research: review loop threw: ${(e as Error).message}`;
    notify(summary, 'error');
    safeJournal(journalPath, 'review loop threw', (e as Error).message);
    return {
      outcome: { kind: 'error', error: (e as Error).message, iterations: 0, bestSoFar: null },
      consented: true,
      firstTimeConsent,
      summary,
      level: 'error',
    };
  }

  // ── 4. Archive both iteration-loop tasks ──────────────────
  const archiveTs = now().toISOString().replace(/[:.]/g, '-');
  for (const task of [taskNames.structural, taskNames.subjective]) {
    try {
      const archivedTo = archiveTask(deps.cwd, task, archiveTs);
      if (archivedTo) {
        safeJournal(journalPath, `iteration-loop archived ${task}`, archivedTo);
      }
    } catch (e) {
      safeJournal(journalPath, `iteration-loop archive failed (${task})`, (e as Error).message);
    }
  }

  // ── 5. Format + notify ────────────────────────────────────
  const { summary, level } = formatOutcome(outcome, { runRoot: deps.runRoot, maxIter: deps.maxIter ?? 4 });
  notify(summary, level);
  safeJournal(journalPath, `review loop terminal (${outcome.kind})`, summary);

  return { outcome, consented: true, firstTimeConsent, summary, level };
}

// ──────────────────────────────────────────────────────────────────────
// Spec builders — exported for tests + downstream observability.
// ──────────────────────────────────────────────────────────────────────

export interface BuildStructuralSpecInput {
  task: string;
  /** Artifact path relative to cwd. The iteration-loop storage uses this for snapshots. */
  reportPath: string;
  bashCmd: string;
  maxIter: number;
  createdAt: string;
}

export function buildStructuralSpec(input: BuildStructuralSpecInput): CheckSpec {
  const bash: BashCheckSpec = { cmd: input.bashCmd, passOn: 'exit-zero' };
  return {
    task: input.task,
    kind: 'bash',
    artifact: input.reportPath,
    budget: { maxIter: input.maxIter },
    spec: bash,
    createdAt: input.createdAt,
  };
}

export interface BuildSubjectiveSpecInput {
  task: string;
  reportPath: string;
  rubric: string;
  maxIter: number;
  createdAt: string;
}

export function buildSubjectiveSpec(input: BuildSubjectiveSpecInput): CheckSpec {
  const critic: CriticCheckSpec = { rubric: input.rubric };
  return {
    task: input.task,
    kind: 'critic',
    artifact: input.reportPath,
    budget: { maxIter: input.maxIter },
    spec: critic,
    createdAt: input.createdAt,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Outcome → (summary, level).
// ──────────────────────────────────────────────────────────────────────

/**
 * Optional renderer context. Populated by {@link runDeepResearchReview}
 * with the current run root + configured `maxIter` so the
 * `budget-exhausted` branch can emit a closeness verdict plus a
 * copy-pasteable `/research --resume --run-root <path>
 * --from=review --review-max-iter <N+2>` command the parent pi/LLM
 * agent can re-invoke without hand-editing. Tests that call
 * {@link formatOutcome} directly may omit the context — the
 * closeness block is appended only when both fields are set.
 */
export interface FormatOutcomeContext {
  runRoot?: string;
  /** The `maxIter` value the review loop was driven with. */
  maxIter?: number;
}

/**
 * Render a review-loop outcome into the `(message, level)` pair
 * the extension uses for `ctx.ui.notify`.
 *
 * On `budget-exhausted`, when {@link FormatOutcomeContext} carries
 * both `runRoot` and `maxIter`, the summary is extended with two
 * extra lines the parent agent consumes as signal: a closeness
 * verdict (`near-pass` / `stuck`) classified by
 * {@link classifyReviewCloseness}, and a ready-to-invoke
 * `/research --resume … --review-max-iter <N+REVIEW_RESUME_BUMP>`
 * command. The closeness block is appended to the existing
 * summary text (rather than a new `closenessHint` field) so every
 * existing caller — including tool-summary folds in
 * `deep-research-tool.ts` — surfaces it for free.
 */
export function formatOutcome(
  outcome: ReviewLoopOutcome,
  ctx: FormatOutcomeContext = {},
): { summary: string; level: 'info' | 'warning' | 'error' } {
  switch (outcome.kind) {
    case 'passed':
      return {
        summary:
          `/research: review PASSED after ${outcome.iterations} iteration${outcome.iterations === 1 ? '' : 's'} ` +
          `(structural ok, critic ${outcome.critic.score.toFixed(2)}). Report ready at ${outcome.reportPath}.`,
        level: 'info',
      };
    case 'stubbed':
      // The wire's short-circuit path builds the full recovery
      // summary via {@link formatStubbedReviewSummary} before ever
      // calling {@link formatOutcome} — that's what the user and
      // the LLM see. This branch exists for callers that invoke
      // {@link formatOutcome} directly on a {@link ReviewLoopOutcome}
      // (tests, downstream renderers) so the switch exhaustively
      // covers the union without falling through.
      return {
        summary:
          `/research: review skipped \u2014 ${outcome.stubbed.length} sub-question section(s) are stubbed as ` +
          `[section unavailable]. Re-fetch before re-running review.`,
        level: 'warning',
      };
    case 'budget-exhausted': {
      const lines: string[] = [];
      lines.push(
        `/research: review budget exhausted (${outcome.stage} stage, ${outcome.iterations} iteration${outcome.iterations === 1 ? '' : 's'}).`,
      );
      if (outcome.bestSoFar) {
        lines.push(
          `  best-so-far: iter ${outcome.bestSoFar.iteration} (${outcome.bestSoFar.stage}, score ${outcome.bestSoFar.score.toFixed(2)}) → ${outcome.bestSoFar.snapshotPath}`,
        );
      }
      if (outcome.stage === 'structural' && outcome.lastStructural.failures.length > 0) {
        lines.push(`  last structural failures (${outcome.lastStructural.failures.length}):`);
        for (const f of outcome.lastStructural.failures.slice(0, 5)) {
          lines.push(`    - [${f.id}] ${f.message}`);
        }
      }
      if (outcome.lastCritic && !outcome.lastCritic.approved) {
        lines.push(
          `  last critic score: ${outcome.lastCritic.score.toFixed(2)} (${outcome.lastCritic.issues.length} issue(s))`,
        );
      }
      // Closeness signal + resume command for the parent agent.
      // Emitted only when the caller passed a runRoot + maxIter
      // so tests that exercise `formatOutcome` in isolation keep
      // their existing assertions.
      if (ctx.runRoot !== undefined && ctx.maxIter !== undefined) {
        const closeness = classifyReviewCloseness(outcome);
        const bump = ctx.maxIter + REVIEW_RESUME_BUMP;
        if (closeness === 'near-pass') {
          lines.push(
            `  Near-pass: the parent agent may continue with a small bump \u2014 one more iteration is likely to converge.`,
          );
        } else if (closeness === 'stuck') {
          lines.push(
            `  Stuck: not close to passing. Review rubric / findings before retrying; another iteration alone may not converge.`,
          );
        }
        lines.push(
          `  Resume: \`/research --resume --run-root ${ctx.runRoot} --from=review --review-max-iter ${bump}\``,
        );
      }
      return { summary: lines.join('\n'), level: 'warning' };
    }
    case 'structural-override':
      return {
        summary:
          `/research: review FAILED — critic approved (${outcome.critic.score.toFixed(2)}) but the structural check regressed on iter ${outcome.iterations}. ` +
          `Structure wins: ${outcome.structural.failures.length} structural failure${outcome.structural.failures.length === 1 ? '' : 's'}. ` +
          `First: ${outcome.structural.failures[0]?.message ?? '(none)'}.`,
        level: 'warning',
      };
    case 'error':
      return {
        summary:
          `/research: review aborted after ${outcome.iterations} iteration${outcome.iterations === 1 ? '' : 's'}: ${outcome.error}` +
          (outcome.bestSoFar ? ` (best-so-far: ${outcome.bestSoFar.snapshotPath})` : ''),
        level: 'error',
      };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Internals.
// ──────────────────────────────────────────────────────────────────────

function noopNotify(): void {
  /* intentional no-op */
}

function safeJournal(
  journalPath: string,
  heading: string,
  body?: string,
  level: 'info' | 'step' | 'warn' | 'error' = 'step',
): void {
  // Journal writes depend on the run root existing; tests can
  // supply a fake run root where it doesn't. Swallow failures so
  // the review loop itself is never blocked on logging.
  try {
    if (!existsSync(dirname(journalPath))) return;
    appendJournal(journalPath, body !== undefined ? { level, heading, body } : { level, heading });
  } catch {
    /* best-effort */
  }
}
