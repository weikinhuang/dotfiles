/* Read "Internals" at the bottom — public API comes first. The
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
 *   - `journal.md` — every phase boundary, retry, nudge, stall,
 *     quarantine lands here.
 *   - `findings/<id>.md` — one per sub-question that completed.
 *   - `findings/<id>.md.provenance.json` — model+ts sidecar.
 *   - `findings/_quarantined/<id>/…` — malformed findings + reason.
 *   - `fanout.json` — resume-friendly handle state.
 *
 * This file does NOT decide whether background or sync fanout is
 * used — the extension picks the mode based on pi's environment.
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
 *   - One subagent failing does NOT abort the run — the fanout
 *     dispatcher buckets each task independently.
 *
 * None of the above is tier-specific.
 */

import { readFileSync } from 'node:fs';

import { join } from 'node:path';
import { ensureDirSync } from './atomic-write.ts';
import {
  type FindingAction,
  classifyFindings,
  findingExists,
  normalizeSourceTitles,
  writeFindingFile,
} from './deep-research-finding.ts';
import { runPlanner, type PlannerResult } from './deep-research-planner.ts';
import {
  type PlanningCriticOutcome,
  type PlanningCriticRunner,
  runPlanningCritic,
} from './deep-research-planning-critic.ts';
import { runSelfCritic } from './deep-research-self-critic.ts';
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
import { type DeepResearchPlan, type PlanBudget } from './research-plan.ts';
import { hashPrompt, type Provenance, writeSidecar } from './research-provenance.ts';
import { failureCounter, quarantine } from './research-quarantine.ts';
import { type ResearchSessionLike } from './research-structured.ts';
import { type TinyAdapter, type TinyCallContext } from './research-tiny.ts';

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
  /** Planner emitted a stuck shape — no plan on disk; user checkpoint. */
  | { kind: 'planner-stuck'; runRoot: string; reason: string }
  /** Planning-critic rejected twice (or its rewrite emitted stuck). */
  | {
      kind: 'checkpoint';
      runRoot: string;
      plan: DeepResearchPlan;
      outcome: PlanningCriticOutcome;
    }
  /** Runner failed to produce a usable verdict — infrastructure trouble. */
  | { kind: 'error'; runRoot: string; plan: DeepResearchPlan | null; error: string };

// ──────────────────────────────────────────────────────────────────────
// Public entry point.
// ──────────────────────────────────────────────────────────────────────

export async function runResearchPipeline<M>(question: string, deps: PipelineDeps<M>): Promise<PipelineOutcome> {
  // ── Create parent session ───────────────────────────────────────
  const session = await deps.createSession();
  let planResult: PlannerResult | null = null;
  try {
    // ── 1. Planner ────────────────────────────────────────────────
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
      return { kind: 'planner-stuck', runRoot: planResult.runRoot, reason: planResult.stuck.reason };
    }

    let plan = planResult.plan;
    const runRoot = planResult.runRoot;
    const p = paths(runRoot);

    // ── 2. Self-critic ────────────────────────────────────────────
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

    // ── 3. Planning-critic ────────────────────────────────────────
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
      return { kind: 'error', runRoot, plan, error: criticOutcome.error };
    }
    if (criticOutcome.kind === 'checkpoint' || criticOutcome.kind === 'rewrite-stuck') {
      // Give the extension a chance to prompt the user; default to
      // halting the pipeline (do not fan out on a rejected plan).
      const decision = deps.onCriticCheckpoint ? await deps.onCriticCheckpoint(criticOutcome) : { continue: false };
      if (!decision.continue) {
        return { kind: 'checkpoint', runRoot, plan, outcome: criticOutcome };
      }
    }

    // ── 4. Fanout ─────────────────────────────────────────────────
    const fanoutResult = await runFanoutPhase({
      plan,
      runRoot,
      deps,
    });

    // ── 5. Post-fanout validation + quarantine ────────────────────
    const quarantined = await absorbFindings({
      fanoutResult,
      plan,
      runRoot,
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
      prompt: renderWebResearcherPrompt(plan, sq.id),
    })),
    wallClockSec: plan.budget.wallClockSec,
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
 */
export function renderWebResearcherPrompt(plan: DeepResearchPlan, subQuestionId: string): string {
  const sq = plan.subQuestions.find((x) => x.id === subQuestionId);
  if (!sq) throw new Error(`renderWebResearcherPrompt: sub-question ${subQuestionId} not found`);
  const outPath = `findings/${sq.id}.md`;
  return [
    `You are the web-researcher for /research sub-question ${sq.id}.`,
    '',
    `Root question (context only): ${plan.question}`,
    `Your sub-question: ${sq.question}`,
    `Write your findings to: ${outPath}`,
    '',
    'Use the fetch_web_* MCP tools to search + read pages. Cite every claim. Use the exact four-heading schema:',
    '',
    '  # Sub-question: <verbatim copy>',
    '',
    '  ## Findings',
    '  - bullet cites [S1], [S2] …',
    '',
    '  ## Sources',
    '  - [S1] <URL> — <description>',
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
 * failure-counter — two failures triggers quarantine). Accepted
 * findings get a provenance sidecar; optionally we run the tiny
 * source-title normalization pass.
 *
 * Returns the list of sub-question ids that got quarantined.
 */
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
    // — useful for mocked spawners that don't touch the file
    // system, and for synchronous-fallback runs where the agent
    // returns the file body inline.
    let body: string;
    if (findingExists(target)) {
      try {
        body = readFileSync(target, 'utf8');
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
        promptHash: hashPrompt(renderWebResearcherPrompt(plan, subQuestionId)),
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
      // Phase 2 does NOT attempt an in-pipeline re-prompt — the
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
      // The spawner never landed a file — persist the raw body
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
  // without findings — journal an explicit entry so synth knows
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
// Helpers.
// ──────────────────────────────────────────────────────────────────────

/**
 * Best-effort guess of the run root before the planner runs —
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
  // Minimal slug — deterministic, no tiny involvement. The planner
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
