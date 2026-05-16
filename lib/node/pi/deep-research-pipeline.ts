/* Read "Internals" at the bottom - public API comes first. The
 * `no-use-before-define` rule is disabled at the file scope because
 * TS function declarations are hoisted and this ordering reads
 * top-down (public API → helpers). */
/* eslint-disable no-use-before-define */

/**
 * Deep-research `/research <question>` orchestration (Phase 2 scope).
 *
 * This module wires the Phase 2 stages together:
 *
 *     planner → self-critic → planning-critic → fanout
 *
 * stopping short of synthesis (Phase 3) and review (Phase 4). It is
 * intentionally pure: every pi dependency is handed in via
 * `PipelineDeps`, so a vitest spec can drive the full pipeline with
 * scripted sessions / critic runners / fanout spawners and no pi
 * runtime. The extension shell at `config/pi/extensions/deep-
 * research.ts` reduces to "build the deps, call this function,
 * forward the summary".
 *
 * A single run of this function produces on-disk state under
 * `<cwd>/research/<slug>/`:
 *
 *   - `plan.json` + `plan.json.provenance.json` (from planner /
 *     self-critic / planning-critic).
 *   - `journal.md` - every phase boundary, retry, nudge, stall,
 *     quarantine lands here.
 *   - `findings/<id>.md` - one per sub-question that completed.
 *   - `findings/<id>.md.provenance.json` - model+ts sidecar.
 *   - `findings/_quarantined/<id>/…` - malformed findings + reason.
 *   - `fanout.json` - resume-friendly handle state.
 *
 * This file does NOT decide whether background or sync fanout is
 * used - the extension picks the mode based on pi's environment.
 *
 * Robustness posture (see `research-extensions-robustness-principle`):
 *
 *   - Planner/self-critic/planning-critic each go through
 *     `research-structured.callTyped` for typed output.
 *   - Stuck at the planner → escalate to user checkpoint.
 *   - Planning-critic rejection → one auto-rewrite → second
 *     rejection → user checkpoint.
 *   - Malformed finding → one re-prompt → second failure →
 *     quarantine.
 *   - Fanout child stall → `research-watchdog` aborts + retries in
 *     parent session (configured by the extension; the pipeline
 *     just threads the spawner through).
 *   - One subagent failing does NOT abort the run - the fanout
 *     dispatcher buckets each task independently.
 *
 * None of the above is tier-specific.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureDirSync } from './atomic-write.ts';
import {
  type FindingAction,
  classifyFindings,
  findingExists,
  normalizeSourceTitles,
  writeFindingFile,
} from './deep-research-finding.ts';
import { extractFindingSourceUrls } from './deep-research-finding.ts';
import { runPlanner, type PlannerResult } from './deep-research-planner.ts';
import {
  type PlanningCriticOutcome,
  type PlanningCriticRunner,
  runPlanningCritic,
} from './deep-research-planning-critic.ts';
import { writeRubricFiles } from './deep-research-rubric.ts';
import { runSelfCritic } from './deep-research-self-critic.ts';
import { type PhaseEvent } from './deep-research-statusline.ts';
import { type SynthMergeResult, UnknownPlaceholderError, runSynthMerge } from './deep-research-synth-merge.ts';
import { type SectionOutcome, runAllSections } from './deep-research-synth-sections.ts';
import {
  type FanoutDeps,
  type FanoutResult,
  type FanoutSpawner,
  type FanoutSpec,
  type FanoutMode,
  fanout,
} from './research-fanout.ts';
import { appendJournal } from './research-journal.ts';
import { paths } from './research-paths.ts';
import { type DeepResearchPlan, type PlanBudget, readPlan } from './research-plan.ts';
import { hashPrompt, type Provenance, stripProvenanceFrontmatter, writeSidecar } from './research-provenance.ts';
import { failureCounter, quarantine } from './research-quarantine.ts';
import { sumFanoutDeficit } from './research-resume.ts';
import { fetchAndStore, listRun, type McpClient, type SourceRef } from './research-sources.ts';
import { type ResearchSessionLike } from './research-structured.ts';
import { type TinyAdapter, type TinyCallContext } from './research-tiny.ts';

// ──────────────────────────────────────────────────────────────────────
// Pipeline stages (used by `--resume` to skip earlier stages).
// ──────────────────────────────────────────────────────────────────────

/**
 * Ordered list of pipeline stages. A `/research --resume --from=<stage>`
 * re-enters the pipeline at `stage` and skips every earlier stage,
 * reading its outputs from disk instead. Order matters: the stage
 * guard compares array indices.
 *
 * Review is listed here for symmetry with the command-surface
 * {@link ../research-command-args.ResumeStage} enum, but the
 * pipeline itself does NOT execute a review phase - that lives in
 * the extension's `runReviewPhase` and is driven separately by
 * `runResumeReviewStage`. Callers must never pass `resumeFrom:
 * 'review'` here; {@link runResearchPipeline} rejects it with an
 * actionable error.
 */
export const PIPELINE_STAGES = ['plan', 'self-crit', 'plan-crit', 'fanout', 'synth', 'review'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** True when `stage` is strictly earlier than `resumeFrom`. */
function shouldSkip(stage: PipelineStage, resumeFrom?: PipelineStage): boolean {
  if (!resumeFrom) return false;
  return PIPELINE_STAGES.indexOf(stage) < PIPELINE_STAGES.indexOf(resumeFrom);
}

// ──────────────────────────────────────────────────────────────────────
// Injected dependencies.
// ──────────────────────────────────────────────────────────────────────

/**
 * All the pi-runtime surface this module touches, hidden behind
 * injection. Production wiring supplies real pi constructors;
 * tests supply hand-rolled mocks.
 */
export interface PipelineDeps<M> {
  /** Caller's working directory. */
  cwd: string;
  /**
   * Called once to produce the parent session the planner /
   * self-critic / planning-critic rewrite turns share. The
   * pipeline calls `.dispose?.()` on return if present; otherwise
   * it just lets the session go out of scope.
   */
  createSession: () => Promise<ResearchSessionLikeWithLifecycle>;
  /** Runner for the `research-planning-critic` subagent. */
  runPlanningCritic: PlanningCriticRunner;
  /** Spawner for fanout `web-researcher` subagents. */
  fanoutSpawn: FanoutSpawner;
  /**
   * Fanout execution mode. `background` when the environment
   * supports `run_in_background: true`; `sync` when it does not.
   */
  fanoutMode: FanoutMode;
  /** Model provenance string for the parent session. */
  model: string;
  /** Thinking level for the parent session. */
  thinkingLevel: string | null;
  /** Budget override. Defaults to the planner's default budget. */
  budget?: PlanBudget;
  /** Abort signal fused with wall-clock inside the fanout. */
  signal?: AbortSignal;
  /** Test clock. */
  now?: () => Date;
  /** Optional tiny adapter + context. */
  tinyAdapter?: TinyAdapter<M>;
  tinyCtx?: TinyCallContext<M>;
  /**
   * Hook invoked once the planning-critic dispatch completes and
   * the pipeline is about to start the fanout. Used by the
   * extension to pause + prompt the user on a `checkpoint`
   * outcome. Returning `{ continue: false }` aborts the pipeline
   * with that outcome; returning `{ continue: true }` (or omitting
   * the hook entirely) proceeds to fanout.
   */
  onCriticCheckpoint?: (outcome: PlanningCriticOutcome) => Promise<{ continue: boolean }> | { continue: boolean };
  /**
   * Forwarded to `research-fanout` as `staleThresholdMs`; the
   * extension picks a production default, tests pass a small
   * value.
   */
  staleThresholdMs?: number;
  /** Forwarded to `research-fanout` as `pollIntervalMs`. */
  pollIntervalMs?: number;
  /** Forwarded to `research-fanout` as its sleep override. */
  sleep?: (ms: number) => Promise<void>;
  /** Forwarded to `research-fanout` as its clock override. */
  clock?: () => number;
  /**
   * Hard cap on the number of parallel fanout subagents. Defaults
   * to `budget.maxSubagents`.
   */
  maxConcurrent?: number;
  /**
   * Wall-clock override for the fanout (seconds). When set,
   * overrides `plan.budget.wallClockSec` when building the
   * `FanoutSpec`. Wired from the user's `--wall-clock` /
   * `wallClockSec` override so local-model runs can extend
   * beyond the planner's default without editing `plan.json`.
   */
  wallClockSecOverride?: number;
  /**
   * Optional McpClient used to populate the run's source store
   * after fanout lands. The synth stage drops citations for URLs
   * that aren't present in `sources/<hash>.md`, so without this
   * every section synthesizes without footnotes. When unset the
   * pipeline skips the populate step and logs a journal warning
   * once - handy for fixture-driven unit tests that don't want
   * to touch the network. Wired from
   * `research-ai-fetch-web-cli-client.createAiFetchWebCliClientFromEnv()`
   * in the extension (which shells out to the `ai-fetch-web` CLI).
   */
  mcpClient?: McpClient;
  /**
   * Phase 3 switch. When true, after fanout + findings absorption
   * the pipeline runs per-sub-question synthesis
   * (`deep-research-synth-sections`) and the merge pass
   * (`deep-research-synth-merge`), emitting a `report-complete`
   * outcome that carries the rendered `report.md` path. When
   * false / unset the pipeline stops at `fanout-complete` (Phase
   * 2 behavior); Phase 2 tests depend on that shape so we leave
   * it as opt-in rather than flipping the default.
   */
  runSynth?: boolean;
  /**
   * Resume mode. When set, the pipeline reads `plan.json` (and
   * every on-disk artifact earlier stages would otherwise have
   * produced) from {@link resumeRunRoot} instead of invoking
   * those stages. {@link PIPELINE_STAGES} defines the order; the
   * pipeline skips every stage strictly earlier than
   * `resumeFrom`.
   *
   *   - `plan-crit` - skip planner + self-critic, re-run
   *     planning-critic against the hand-edited / on-disk plan.
   *   - `fanout`    - skip plan+self-crit+plan-crit; run fanout
   *     (idempotent - the caller should have run
   *     `invalidateIncompleteFanoutTasks` first when re-dispatch
   *     is desired) + synth + merge.
   *   - `synth`     - skip every earlier stage; read findings
   *     from disk and run synth + merge only.
   *   - `review`    - NOT supported at the pipeline level. The
   *     extension drives review resume directly via
   *     `runResumeReviewStage` (no pipeline invocation). Passing
   *     `'review'` here is a programmer error.
   *
   * When `resumeFrom` is set, `resumeRunRoot` MUST also be set.
   */
  resumeFrom?: PipelineStage;
  /**
   * Absolute run root the resume flow validated upstream (see
   * `research-resume.validateRunRoot`). Required when
   * {@link resumeFrom} is set.
   */
  resumeRunRoot?: string;
  /**
   * Optional sub-question filter threaded into the synth stage.
   * When non-empty, {@link runAllSections} re-synthesizes only
   * the listed ids; every other sub-question in the plan emits
   * a pass-through outcome pointing at its existing
   * `snapshots/sections/<id>.md` so the merge can skip the LLM
   * turn for unaffected sections. Only meaningful on the
   * `--sq` resume path; ignored on a fresh run.
   *
   * Out-of-plan ids are pre-validated by the extension's
   * `research-resume.scopeFanoutDeficit` check before the
   * pipeline is invoked.
   */
  synthSubQuestionIds?: readonly string[];
  /**
   * Phase-5 observability hook: the pipeline emits one
   * {@link PhaseEvent} per macro boundary so the extension can
   * keep a statusline widget in sync. No-op when unset; the
   * pipeline never awaits the hook (it's fire-and-forget so a
   * slow UI write never stalls the research run). Exceptions
   * from the hook are swallowed for the same reason.
   *
   * Per-task `fanout-progress` granularity is NOT emitted by the
   * pipeline itself - it only emits one `fanout-start` (before
   * `research-fanout`) and one `fanout-progress` with the final
   * cumulative count (after it returns). Extensions that want
   * sub-task progress can wrap their `fanoutSpawn` to emit extra
   * `fanout-progress` events through this same hook as each
   * task's `wait()` resolves; `deep-research-tool.ts` does not
   * ship such a wrapper because the ergonomics of "total" are
   * owned by the extension (the reducer inherits `total` from
   * state when the event omits it).
   */
  onPhase?: (event: PhaseEvent) => void;
}

/** Session that optionally knows how to clean up after itself. */
export interface ResearchSessionLikeWithLifecycle extends ResearchSessionLike {
  dispose?: () => void | Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────
// Pipeline outcome.
// ──────────────────────────────────────────────────────────────────────

export type PipelineOutcome =
  /** Fanout ran (possibly with some aborted / failed tasks). */
  | {
      kind: 'fanout-complete';
      runRoot: string;
      plan: DeepResearchPlan;
      fanout: FanoutResult;
      quarantined: string[];
    }
  /**
   * Phase 3 terminal outcome: synth + merge completed and
   * `report.md` lives under the run root. Still carries the
   * fanout detail for consumers that want to surface
   * completed / failed / aborted counts in their summary.
   */
  | {
      kind: 'report-complete';
      runRoot: string;
      plan: DeepResearchPlan;
      fanout: FanoutResult;
      quarantined: string[];
      sections: SectionOutcome[];
      merge: SynthMergeResult;
    }
  /** Planner emitted a stuck shape - no plan on disk; user checkpoint. */
  | { kind: 'planner-stuck'; runRoot: string; reason: string }
  /** Planning-critic rejected twice (or its rewrite emitted stuck). */
  | {
      kind: 'checkpoint';
      runRoot: string;
      plan: DeepResearchPlan;
      outcome: PlanningCriticOutcome;
    }
  /** Runner failed to produce a usable verdict - infrastructure trouble. */
  | { kind: 'error'; runRoot: string; plan: DeepResearchPlan | null; error: string };

// ──────────────────────────────────────────────────────────────────────
// Public entry point.
// ──────────────────────────────────────────────────────────────────────

export async function runResearchPipeline<M>(question: string, deps: PipelineDeps<M>): Promise<PipelineOutcome> {
  // ── 0. Resume-mode preconditions ───────────────────────────────
  if (deps.resumeFrom && !deps.resumeRunRoot) {
    throw new Error(
      'runResearchPipeline: resumeFrom requires resumeRunRoot (validate via research-resume.validateRunRoot)',
    );
  }
  if (deps.resumeFrom === 'review') {
    throw new Error(
      "runResearchPipeline: resumeFrom='review' is not supported at the pipeline layer; the extension drives review resume via runResumeReviewStage without invoking runResearchPipeline",
    );
  }

  // ── Create parent session ───────────────────────────────────────
  const session = await deps.createSession();
  emitPhase(deps, { kind: 'start' });
  let planResult: PlannerResult | null = null;
  try {
    // ── 1. Planner ────────────────────────────────────────────────
    let plan: DeepResearchPlan;
    let runRoot: string;
    if (shouldSkip('plan', deps.resumeFrom)) {
      // Resume path: plan lives on disk under the caller-validated
      // resumeRunRoot. `readPlan` re-validates the JSON shape;
      // anything malformed surfaces as a thrown error at the
      // extension boundary.
      runRoot = deps.resumeRunRoot!;
      const planPath = paths(runRoot).plan;
      if (!existsSync(planPath)) {
        throw new Error(`runResearchPipeline: resumeFrom=${deps.resumeFrom} requires plan.json at ${planPath}`);
      }
      const loaded = readPlan(planPath);
      if (loaded.kind !== 'deep-research') {
        throw new Error(`runResearchPipeline: plan at ${planPath} is kind=${loaded.kind}; expected deep-research`);
      }
      plan = loaded;
      try {
        appendJournal(paths(runRoot).journal, {
          level: 'step',
          heading: `resume entered at stage=${deps.resumeFrom}`,
          body: `reading plan.json (${plan.subQuestions.length} sub-questions) from disk; earlier stages skipped`,
        });
      } catch {
        /* swallow */
      }
    } else {
      emitPhase(deps, { kind: 'planning' });
      planResult = await runPlanner({
        question,
        cwd: deps.cwd,
        session,
        model: deps.model,
        thinkingLevel: deps.thinkingLevel,
        ...(deps.budget !== undefined ? { budget: deps.budget } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.tinyAdapter !== undefined ? { tinyAdapter: deps.tinyAdapter } : {}),
        ...(deps.tinyCtx !== undefined ? { tinyCtx: deps.tinyCtx } : {}),
        journalPath: paths(resolveRunRootFromCwd(deps.cwd, question)).journal,
      });

      if (planResult.stuck) {
        emitPhase(deps, { kind: 'error', message: `planner stuck: ${planResult.stuck.reason}` });
        return { kind: 'planner-stuck', runRoot: planResult.runRoot, reason: planResult.stuck.reason };
      }

      plan = planResult.plan;
      runRoot = planResult.runRoot;
    }
    const p = paths(runRoot);

    // ── 2. Self-critic ────────────────────────────────────────────
    if (!shouldSkip('self-crit', deps.resumeFrom)) {
      emitPhase(deps, { kind: 'self-crit' });
      const selfCritic = await runSelfCritic({
        runRoot,
        plan,
        session,
        model: deps.model,
        thinkingLevel: deps.thinkingLevel,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.tinyAdapter !== undefined ? { tinyAdapter: deps.tinyAdapter } : {}),
        ...(deps.tinyCtx !== undefined ? { tinyCtx: deps.tinyCtx } : {}),
        journalPath: p.journal,
      });
      plan = selfCritic.plan;
    }

    // ── 3. Planning-critic ────────────────────────────────────────
    if (!shouldSkip('plan-crit', deps.resumeFrom)) {
      emitPhase(deps, { kind: 'plan-crit' });
      const criticOutcome = await runPlanningCritic({
        runRoot,
        plan,
        session,
        runCritic: deps.runPlanningCritic,
        model: deps.model,
        thinkingLevel: deps.thinkingLevel,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        journalPath: p.journal,
      });

      // Collect the post-rewrite plan (planning-critic may have
      // overwritten plan.json on disk). `outcome.plan` is the
      // authoritative in-memory view.
      plan = criticOutcome.plan;

      if (criticOutcome.kind === 'error') {
        emitPhase(deps, { kind: 'error', message: `plan-crit error: ${criticOutcome.error}` });
        return { kind: 'error', runRoot, plan, error: criticOutcome.error };
      }
      if (criticOutcome.kind === 'checkpoint' || criticOutcome.kind === 'rewrite-stuck') {
        // Give the extension a chance to prompt the user; default to
        // halting the pipeline (do not fan out on a rejected plan).
        const decision = deps.onCriticCheckpoint ? await deps.onCriticCheckpoint(criticOutcome) : { continue: false };
        if (!decision.continue) {
          emitPhase(deps, { kind: 'error', message: `plan-crit checkpoint (${criticOutcome.kind})` });
          return { kind: 'checkpoint', runRoot, plan, outcome: criticOutcome };
        }
      }
    }

    // ── 3b. Rubric files ─────────────────────────────────────────
    // Materialize rubric-structural.md + rubric-subjective.md
    // once the plan is locked. `preserveExisting: true` keeps a
    // user-edited rubric from being clobbered on /research --resume.
    try {
      const rubricOutcome = writeRubricFiles({ runRoot, plan, preserveExisting: true });
      if (rubricOutcome.wrote.structural || rubricOutcome.wrote.subjective) {
        appendJournal(p.journal, {
          level: 'step',
          heading: 'rubric files materialized',
          body: `structural=${rubricOutcome.wrote.structural} subjective=${rubricOutcome.wrote.subjective}`,
        });
      }
    } catch (e) {
      // Rubric emission is not load-bearing - the Phase 4 review
      // surfaces the problem when the files are missing. Journal
      // the failure and continue.
      try {
        appendJournal(p.journal, {
          level: 'warn',
          heading: 'rubric emission failed',
          body: (e as Error).message,
        });
      } catch {
        /* swallow */
      }
    }

    // ── 4. Fanout ─────────────────────────────────────────────────
    let fanoutResult: FanoutResult;
    let quarantined: string[];
    if (shouldSkip('fanout', deps.resumeFrom)) {
      // Synth / later: reconstruct the fanout snapshot from disk so
      // downstream consumers (journal summary, return outcome)
      // see consistent counts without re-dispatching.
      //
      // Assert every sub-question has a non-empty finding on disk;
      // synth with a missing finding would silently stub the
      // section and waste a review iteration on an unfixable
      // defect. `sumFanoutDeficit` is the same check the resume
      // auto-detector uses.
      const deficit = sumFanoutDeficit(
        runRoot,
        plan.subQuestions.map((sq) => sq.id),
      );
      if (deficit.length > 0) {
        throw new Error(
          `runResearchPipeline: resumeFrom=${deps.resumeFrom} but findings incomplete for: ${deficit.join(', ')} ` +
            `- resume from fanout instead (/research --resume --from=fanout)`,
        );
      }
      fanoutResult = loadResumeFanoutSnapshot(runRoot, plan);
      quarantined = [];
      try {
        appendJournal(p.journal, {
          level: 'step',
          heading: 'fanout skipped (resume)',
          body:
            `completed=${fanoutResult.completed.length} ` +
            `failed=${fanoutResult.failed.length} ` +
            `aborted=${fanoutResult.aborted.length}`,
        });
      } catch {
        /* swallow */
      }
    } else {
      emitPhase(deps, { kind: 'fanout-start', total: plan.subQuestions.length });
      fanoutResult = await runFanoutPhase({
        plan,
        runRoot,
        deps,
      });
      emitPhase(deps, {
        kind: 'fanout-progress',
        done: fanoutResult.completed.length + fanoutResult.failed.length + fanoutResult.aborted.length,
        total: plan.subQuestions.length,
      });

      // ── 5. Post-fanout validation + quarantine ────────────────────
      quarantined = await absorbFindings({
        fanoutResult,
        plan,
        runRoot,
        deps,
      });
    }

    // Populate source store from accepted findings. The
    // web-researcher subagent fetched pages through its flat MCP
    // tools, but those responses never made it into the run's
    // source store. Walk every accepted finding's `## Sources`
    // block and call `research-sources.fetchAndStore` for each
    // URL - this is the ONLY populate step; without it the synth
    // stage drops every citation because `collectReferencedSources`
    // filters by the on-disk source index.
    await populateSourceStore({
      plan,
      runRoot,
      quarantined: new Set(quarantined),
      deps,
    });

    // Journal fanout summary.
    try {
      appendJournal(p.journal, {
        level: 'step',
        heading: 'fanout complete',
        body:
          `completed=${fanoutResult.completed.length} ` +
          `failed=${fanoutResult.failed.length} ` +
          `aborted=${fanoutResult.aborted.length} ` +
          `quarantined=${quarantined.length}`,
      });
    } catch {
      /* swallow */
    }

    // ── 6. Synth + merge (Phase 3, opt-in) ───────────────────────
    if (deps.runSynth) {
      try {
        emitPhase(deps, { kind: 'synth-start', total: plan.subQuestions.length });
        const synthResult = await runSynthPhase({
          runRoot,
          plan,
          session,
          deps,
          quarantinedFindings: new Set(quarantined),
        });
        return {
          kind: 'report-complete',
          runRoot,
          plan,
          fanout: fanoutResult,
          quarantined,
          sections: synthResult.sections,
          merge: synthResult.merge,
        };
      } catch (e) {
        // `UnknownPlaceholderError` is a typed reject path from
        // merge when a synth output cites an id not in the source
        // store. The error's `.unknown` field lists the offenders
        // verbatim so the journal entry is actionable.
        const reason =
          e instanceof UnknownPlaceholderError
            ? `research-citations rejected unknown source ids: ${e.unknown.join(', ')}`
            : (e as Error).message;
        try {
          appendJournal(p.journal, {
            level: 'error',
            heading: 'synth phase failed',
            body: reason,
          });
        } catch {
          /* swallow */
        }
        emitPhase(deps, { kind: 'error', message: `synth failed: ${reason}` });
        return { kind: 'error', runRoot, plan, error: reason };
      }
    }

    return {
      kind: 'fanout-complete',
      runRoot,
      plan,
      fanout: fanoutResult,
      quarantined,
    };
  } finally {
    if (session.dispose) {
      try {
        await session.dispose();
      } catch {
        /* best-effort */
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Stages.
// ──────────────────────────────────────────────────────────────────────

interface FanoutPhaseArgs<M> {
  plan: DeepResearchPlan;
  runRoot: string;
  deps: PipelineDeps<M>;
}

async function runFanoutPhase<M>(args: FanoutPhaseArgs<M>): Promise<FanoutResult> {
  const { plan, runRoot, deps } = args;
  const p = paths(runRoot);
  ensureDirSync(p.findings);

  const spec: FanoutSpec = {
    agentName: 'web-researcher',
    mode: deps.fanoutMode,
    tasks: plan.subQuestions.map((sq) => ({
      id: sq.id,
      prompt: renderWebResearcherPrompt(plan, sq.id, runRoot),
    })),
    wallClockSec: deps.wallClockSecOverride ?? plan.budget.wallClockSec,
    ...(deps.maxConcurrent !== undefined
      ? { maxConcurrent: deps.maxConcurrent }
      : { maxConcurrent: plan.budget.maxSubagents }),
  };

  const fanoutDeps: FanoutDeps = {
    spawn: deps.fanoutSpawn,
    journalPath: p.journal,
    ...(deps.staleThresholdMs !== undefined ? { staleThresholdMs: deps.staleThresholdMs } : {}),
    ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  };

  return fanout(spec, runRoot, fanoutDeps);
}

/**
 * Render the per-sub-question prompt fed into each fanout task.
 * Mirrors the agent definition: identify the sub-question, the
 * target file path, success criteria, and the schema. Deliberately
 * imperative; small models need the schema repeated inline.
 *
 * `runRoot` is required so the prompt can hand the subagent an
 * absolute output path - with `isolation: shared-cwd` the
 * subagent's cwd is the workspace root, NOT the run root, so a
 * relative `findings/<id>.md` would land at
 * `<workspace>/findings/<id>.md` instead of the run directory.
 * We still quote the relative form in a second line for log
 * readability.
 */
export function renderWebResearcherPrompt(plan: DeepResearchPlan, subQuestionId: string, runRoot?: string): string {
  const sq = plan.subQuestions.find((x) => x.id === subQuestionId);
  if (!sq) throw new Error(`renderWebResearcherPrompt: sub-question ${subQuestionId} not found`);
  const relPath = `findings/${sq.id}.md`;
  const absPath = runRoot !== undefined ? join(runRoot, relPath) : relPath;
  return [
    `You are the web-researcher for /research sub-question ${sq.id}.`,
    '',
    `Root question (context only): ${plan.question}`,
    `Your sub-question: ${sq.question}`,
    `Write your findings to this ABSOLUTE path (your cwd is the workspace root, not the run directory): ${absPath}`,
    `The file will land at "${relPath}" under the run root - pass the absolute path above to your \`write\` tool.`,
    '',
    'Use the `ai-fetch-web` CLI via your `bash` tool for every page I/O. Redirect large fetches to a temp file and then `read` the file - do NOT dump full article bodies into a single tool-output block:',
    '',
    '  bash: ai-fetch-web search "<query>" --limit 5',
    '  bash: ai-fetch-web fetch <url> > /tmp/src.md   # then: read /tmp/src.md',
    '  bash: ai-fetch-web fetch-many <url> <url> > /tmp/batch.md  # parallel batch to disk',
    '',
    'Do NOT invoke the fetch_web MCP server directly, and do NOT run `curl`. Cite every claim. Use the exact four-heading schema:',
    '',
    '  # Sub-question: <verbatim copy>',
    '',
    '  ## Findings',
    '  - bullet cites [S1], [S2] …',
    '',
    '  ## Sources',
    '  - [S1] <URL> - <description>',
    '',
    '  ## Open questions',
    '  - bullet, or "None."',
    '',
    'Emit the full file with a single `write` call, then return a short confirmation and stop. Do not answer other sub-questions.',
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Post-fanout validation + quarantine.
// ──────────────────────────────────────────────────────────────────────

interface AbsorbArgs<M> {
  fanoutResult: FanoutResult;
  plan: DeepResearchPlan;
  runRoot: string;
  deps: PipelineDeps<M>;
}

/**
 * For each completed fanout task, validate the emitted findings
 * file OR the spawner's output string (we prefer on-disk content
 * when present so re-prompts written to disk in a prior session
 * are absorbed on resume). Malformed → re-prompt (logged; the
 * pipeline's retry budget is one re-prompt enforced by the
 * failure-counter - two failures triggers quarantine). Accepted
 * findings get a provenance sidecar; optionally we run the tiny
 * source-title normalization pass.
 *
 * Returns the list of sub-question ids that got quarantined.
 */
/**
 * Strip a leading YAML frontmatter block (`---\n…\n---\n`) if
 * present. Thin local alias over
 * {@link stripProvenanceFrontmatter} from `research-provenance.ts`
 * so the two consumers (this resume path and
 * `deep-research-synth-merge.loadSectionBody`) share the same
 * implementation - a snapshot body written with an inlined
 * provenance frontmatter otherwise leaks the `---…---` block
 * into the merged report and confuses every downstream parser.
 */
function stripSnapshotFrontmatter(text: string): string {
  return stripProvenanceFrontmatter(text);
}

async function absorbFindings<M>(args: AbsorbArgs<M>): Promise<string[]> {
  const { fanoutResult, plan, runRoot, deps } = args;
  const p = paths(runRoot);
  ensureDirSync(p.findings);
  const counter = failureCounter(join(runRoot, 'findings', '.failure-counts.json'));
  const quarantined: string[] = [];

  for (const completion of fanoutResult.completed) {
    const subQuestionId = completion.id;
    const sq = plan.subQuestions.find((x) => x.id === subQuestionId);
    if (!sq) {
      try {
        appendJournal(p.journal, {
          level: 'warn',
          heading: `fanout produced finding for unknown sub-question ${subQuestionId}`,
        });
      } catch {
        /* swallow */
      }
      continue;
    }

    const target = join(p.findings, `${subQuestionId}.md`);

    // Prefer the on-disk file (the agent's `write` tool put it
    // there). Fall back to the spawner's returned output string
    // - useful for mocked spawners that don't touch the file
    // system, and for synchronous-fallback runs where the agent
    // returns the file body inline.
    //
    // A previously-accepted finding on disk carries the provenance
    // YAML frontmatter that `writeSidecar` inlined on first
    // acceptance. Strip it before re-validating so a second pass
    // (resume / retry) doesn't falsely classify a healthy finding
    // as malformed just because its first line is now `---`
    // instead of `# Sub-question:`.
    let body: string;
    if (findingExists(target)) {
      try {
        body = stripSnapshotFrontmatter(readFileSync(target, 'utf8'));
      } catch {
        body = completion.output;
      }
    } else {
      body = completion.output;
    }

    const priorFailures = counter.get(subQuestionId);
    const action: FindingAction = classifyFindings({ text: body, subQuestionId, priorFailures });

    if (action.kind === 'accept') {
      // Optional tiny source-title normalization (decorative only).
      if (deps.tinyAdapter && deps.tinyCtx && deps.tinyAdapter.isEnabled()) {
        try {
          const normalizedSources = await normalizeSourceTitles({
            sections: action.sections,
            adapter: deps.tinyAdapter,
            ctx: deps.tinyCtx,
          });
          if (normalizedSources !== action.sections.sources) {
            // Splice the normalized sources block back into the body.
            const out = action.normalized.replace(action.sections.sources, normalizedSources);
            writeFindingFile(target, out);
          } else {
            writeFindingFile(target, action.normalized);
          }
        } catch {
          writeFindingFile(target, action.normalized);
        }
      } else {
        writeFindingFile(target, action.normalized);
      }
      const provenance: Provenance = {
        model: deps.model,
        thinkingLevel: deps.thinkingLevel,
        timestamp: (deps.now ? deps.now() : new Date()).toISOString(),
        promptHash: hashPrompt(renderWebResearcherPrompt(plan, subQuestionId, runRoot)),
      };
      writeSidecar(target, provenance);
      counter.reset(subQuestionId);
      if (action.truncated) {
        try {
          appendJournal(p.journal, {
            level: 'warn',
            heading: `findings ${subQuestionId} truncated to content-length cap`,
          });
        } catch {
          /* swallow */
        }
      }
      continue;
    }

    if (action.kind === 'reprompt') {
      // Phase 2 does NOT attempt an in-pipeline re-prompt - the
      // single-attempt semantics of `research-fanout` mean a
      // re-prompt is a new fanout task, which the extension owns
      // after the user intervenes. Bump the counter and emit the
      // re-prompt payload into the journal so a later resume
      // run sees it.
      counter.bump(subQuestionId);
      try {
        appendJournal(p.journal, {
          level: 'warn',
          heading: `findings ${subQuestionId} malformed (re-prompt queued)`,
          body: action.reprompt,
        });
      } catch {
        /* swallow */
      }
      // Persist the raw body so the user (and the resume path)
      // can inspect what was rejected.
      writeFindingFile(target, body);
      // Crucially: do NOT hand this malformed body to synth. With
      // no in-pipeline re-prompt firing, synth would read the raw
      // reply text, find no `## Sources` section, and emit a
      // confident zero-citation section. Mark the sub-question
      // quarantined for synth purposes so it gets a visible
      // `[section unavailable: ...]` stub in the merged report
      // - the on-disk file stays put for `--resume` inspection.
      quarantined.push(subQuestionId);
      continue;
    }

    // quarantine: move whatever exists on disk under the
    // sibling `_quarantined/<ts>/` tree.
    if (findingExists(target)) {
      try {
        quarantine(target, action.reason, { caller: 'deep-research-pipeline' });
      } catch (e) {
        try {
          appendJournal(p.journal, {
            level: 'error',
            heading: `quarantine failed for ${subQuestionId}`,
            body: (e as Error).message,
          });
        } catch {
          /* swallow */
        }
      }
    } else {
      // The spawner never landed a file - persist the raw body
      // into the quarantine dir directly so the reader has
      // something to inspect.
      const tempPath = join(p.findings, `${subQuestionId}.md`);
      writeFindingFile(tempPath, body);
      try {
        quarantine(tempPath, action.reason, { caller: 'deep-research-pipeline' });
      } catch (e) {
        try {
          appendJournal(p.journal, {
            level: 'error',
            heading: `quarantine failed for ${subQuestionId}`,
            body: (e as Error).message,
          });
        } catch {
          /* swallow */
        }
      }
    }
    quarantined.push(subQuestionId);
    try {
      appendJournal(p.journal, {
        level: 'warn',
        heading: `findings ${subQuestionId} quarantined`,
        body: action.reason,
      });
    } catch {
      /* swallow */
    }
  }

  // Aborted / failed fanout tasks also leave the sub-question
  // without findings - journal an explicit entry so synth knows
  // why the section will be missing.
  for (const f of fanoutResult.failed) {
    try {
      appendJournal(paths(runRoot).journal, {
        level: 'warn',
        heading: `fanout task ${f.id} failed`,
        body: f.reason,
      });
    } catch {
      /* swallow */
    }
  }
  for (const a of fanoutResult.aborted) {
    try {
      appendJournal(paths(runRoot).journal, {
        level: 'warn',
        heading: `fanout task ${a.id} aborted`,
        body: a.reason,
      });
    } catch {
      /* swallow */
    }
  }

  return quarantined;
}

// ──────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────
// Source-store populate (Phase 6).
// ───────────────────────────────────────────────────────────────────

interface PopulateArgs<M> {
  plan: DeepResearchPlan;
  runRoot: string;
  /** Sub-question ids whose findings did not survive absorb. */
  quarantined: ReadonlySet<string>;
  deps: PipelineDeps<M>;
}

/**
 * For each accepted finding on disk, walk its `## Sources` block
 * and call `fetchAndStore` for every URL. This is the ONLY step
 * that populates `sources/<hash>.md` + `<hash>.json`; without it
 * the synth stage drops every citation because
 * `collectReferencedSources` filters by the on-disk source index.
 *
 * Cost-aware: `fetchAndStore` hits the on-disk cache first, so a
 * second `/research --resume` run does zero network work. Bounded
 * by `plan.budget.maxFetches` to match the planner's contract; a
 * finding that cites more than the budget allows gets its extra
 * URLs dropped (with a journal warning) rather than busting the
 * budget.
 *
 * Degrades gracefully when `deps.mcpClient` is unset - journal a
 * one-shot warning and return. The downstream synth stage will
 * still run but produce zero-citation sections; structural check
 * will fail the refinement loop, which is the right outcome for a
 * pipeline that lost its fetch capability.
 */
async function populateSourceStore<M>(args: PopulateArgs<M>): Promise<void> {
  const { plan, runRoot, quarantined, deps } = args;
  const p = paths(runRoot);
  const client = deps.mcpClient;
  if (!client) {
    try {
      appendJournal(p.journal, {
        level: 'warn',
        heading: 'source-store populate skipped',
        body: 'no McpClient injected - synth will produce zero-citation sections unless a downstream cache is populated by other means.',
      });
    } catch {
      /* swallow */
    }
    return;
  }

  const maxFetches = plan.budget.maxFetches;
  let fetched = 0;
  let cacheHits = 0;
  let failed = 0;
  let dropped = 0;
  const seen = new Set<string>();
  const nowFactory = deps.now ? { now: deps.now } : {};

  for (const sq of plan.subQuestions) {
    if (quarantined.has(sq.id)) continue;
    const findingPath = join(p.findings, `${sq.id}.md`);
    let body: string;
    try {
      body = readFileSync(findingPath, 'utf8');
    } catch {
      continue;
    }
    const urls = extractFindingSourceUrls(body);
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      if (fetched + cacheHits >= maxFetches) {
        dropped += 1;
        continue;
      }
      try {
        const ref = await fetchAndStore(runRoot, url, client, nowFactory);
        if (ref.method === 'cached') cacheHits += 1;
        else if (ref.method === 'fetch') fetched += 1;
        else failed += 1;
      } catch (e) {
        failed += 1;
        try {
          appendJournal(p.journal, {
            level: 'warn',
            heading: `source-store fetch failed for ${url}`,
            body: (e as Error).message,
          });
        } catch {
          /* swallow */
        }
      }
    }
  }

  try {
    appendJournal(p.journal, {
      level: 'step',
      heading: 'source-store populated',
      body: `fetched=${fetched} cached=${cacheHits} failed=${failed} dropped=${dropped} cap=${maxFetches}`,
    });
  } catch {
    /* swallow */
  }
}

// ───────────────────────────────────────────────────────────────────
// Synth + merge phase (Phase 3).
// ──────────────────────────────────────────────────────────────────────

interface SynthPhaseArgs<M> {
  runRoot: string;
  plan: DeepResearchPlan;
  session: ResearchSessionLike;
  deps: PipelineDeps<M>;
  /** Sub-question ids whose findings were quarantined upstream. */
  quarantinedFindings: ReadonlySet<string>;
}

/**
 * Drive `runAllSections` then `runSynthMerge` against the parent
 * session. The source index is loaded once and shared between
 * both stages; everything else (tiny adapter, clock, journal
 * path) threads through unchanged.
 *
 * Errors from `runSynthMerge` (notably {@link UnknownPlaceholderError})
 * propagate - the caller maps them to a `{kind:'error'}` outcome.
 */
async function runSynthPhase<M>(args: SynthPhaseArgs<M>): Promise<{
  sections: SectionOutcome[];
  merge: SynthMergeResult;
}> {
  const { runRoot, plan, session, deps, quarantinedFindings } = args;
  const p = paths(runRoot);
  ensureDirSync(runRoot);

  // One listing used by both stages - `research-sources.listRun`
  // is O(N) in the source store size; not load-bearing for speed
  // but avoids doing it twice.
  const sourceIndex: SourceRef[] = listRun(runRoot);

  let sectionsDone = 0;
  const sections = await runAllSections<M>({
    runRoot,
    plan,
    session,
    model: deps.model,
    thinkingLevel: deps.thinkingLevel,
    quarantinedFindings,
    sourceIndex,
    journalPath: p.journal,
    onSection: (): void => {
      sectionsDone += 1;
      emitPhase(deps, {
        kind: 'synth-progress',
        done: sectionsDone,
        total: plan.subQuestions.length,
      });
    },
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.tinyAdapter !== undefined ? { tinyAdapter: deps.tinyAdapter } : {}),
    ...(deps.tinyCtx !== undefined ? { tinyCtx: deps.tinyCtx } : {}),
    ...(deps.synthSubQuestionIds && deps.synthSubQuestionIds.length > 0
      ? { subQuestionIds: deps.synthSubQuestionIds }
      : {}),
  });

  emitPhase(deps, { kind: 'merge' });
  const merge = await runSynthMerge<M>({
    runRoot,
    plan,
    sectionOutcomes: sections,
    session,
    model: deps.model,
    thinkingLevel: deps.thinkingLevel,
    sourceIndex,
    journalPath: p.journal,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.tinyAdapter !== undefined ? { tinyAdapter: deps.tinyAdapter } : {}),
    ...(deps.tinyCtx !== undefined ? { tinyCtx: deps.tinyCtx } : {}),
  });
  return { sections, merge };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers.
// ──────────────────────────────────────────────────────────────────────

/**
 * Reconstruct a {@link FanoutResult} from on-disk state. Used on
 * resume flows that skip fanout (`resumeFrom` in {synth}) so the
 * outcome object still carries consistent completed / failed /
 * aborted counts. Source of truth: `fanout.json`'s `tasks[*].state`
 * field; we fall back to finding-file presence for plans whose
 * fanout.json predates the `state` field.
 *
 * The `output` field on completed entries is deliberately left as
 * whatever `fanout.json` persisted - downstream synth reads the
 * finding files on disk directly via
 * {@link deep-research-synth-sections.runAllSections}, never from
 * `fanoutResult.completed[*].output`.
 */
function loadResumeFanoutSnapshot(runRoot: string, plan: DeepResearchPlan): FanoutResult {
  const p = paths(runRoot);
  const result: FanoutResult = { completed: [], failed: [], aborted: [] };

  interface PersistedTask {
    id?: unknown;
    state?: unknown;
    output?: unknown;
    reason?: unknown;
  }
  const taskMap = new Map<string, PersistedTask>();
  if (existsSync(p.fanout)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(p.fanout, 'utf8'));
      if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)) {
        for (const t of (raw as { tasks: unknown[] }).tasks) {
          if (t === null || typeof t !== 'object') continue;
          const id = (t as PersistedTask).id;
          if (typeof id === 'string') taskMap.set(id, t);
        }
      }
    } catch {
      /* swallow - fall through to per-id lookup below */
    }
  }

  for (const sq of plan.subQuestions) {
    const task = taskMap.get(sq.id);
    const state = task?.state;
    const output = typeof task?.output === 'string' ? task.output : '';
    const reason = typeof task?.reason === 'string' ? task.reason : '';
    if (state === 'completed') {
      result.completed.push({ id: sq.id, output });
      continue;
    }
    if (state === 'aborted') {
      result.aborted.push({ id: sq.id, reason: reason || 'aborted' });
      continue;
    }
    if (state === 'failed') {
      result.failed.push({ id: sq.id, reason: reason || 'failed' });
      continue;
    }
    // No recorded state: fall back to finding-file presence.
    if (existsSync(join(p.findings, `${sq.id}.md`))) {
      result.completed.push({ id: sq.id, output });
    } else {
      result.failed.push({ id: sq.id, reason: 'no fanout state and no finding on disk' });
    }
  }
  return result;
}

/**
 * Best-effort guess of the run root before the planner runs -
 * only used for the journal path we hand the planner. When the
 * planner's slug resolution yields a different directory, the
 * journal still lands in the right place because `appendJournal`
 * is called with `paths(runRoot).journal` post-planner.
 *
 * The trick: slugify the raw question ahead of time for the
 * journal path only. If the tiny adapter rewrites the slug, the
 * post-planner calls will target the correct journal; the
 * "best-effort" journal path from before the rewrite points at
 * a directory that never existed and `appendJournal` either
 * creates it or silently fails (swallowed by the planner's own
 * `journalIf`).
 *
 * In practice we also pass the pre-planner journal path through
 * `existsSync` gating inside each module's `journalIf`, so the
 * directory-not-found case writes nothing.
 */
function resolveRunRootFromCwd(cwd: string, question: string): string {
  // Minimal slug - deterministic, no tiny involvement. The planner
  // picks the real slug afterwards.
  const slug =
    question
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'research';
  return join(cwd, 'research', slug);
}

/**
 * Fire-and-forget phase emitter. Never awaits, never re-throws -
 * observability MUST NOT block or break the pipeline.
 */
function emitPhase<M>(deps: PipelineDeps<M>, event: PhaseEvent): void {
  if (!deps.onPhase) return;
  try {
    deps.onPhase(event);
  } catch {
    /* swallow - observability hook failures are never load-bearing */
  }
}
