/* Read "Internals" at the bottom - public API comes first. The
 * `no-use-before-define` rule is disabled at the file scope
 * because TS function declarations are hoisted and this file
 * reads top-down (public API → helpers). */
/* eslint-disable no-use-before-define */

/**
 * Phase-6b refinement runner for the deep-research review loop.
 *
 * When the two-stage review declares a report failed (either the
 * deterministic structural check or the subjective critic), this
 * module re-runs the synth stage with a nudge threaded into the
 * prompt, rewriting `report.md` in place. The review loop then
 * re-validates the new report; up to `maxIter` refinements run
 * before the loop terminates with `budget-exhausted` and best-so-
 * far.
 *
 * Two refinement modes:
 *
 *   1. **Structural failures with a per-section location.** We map
 *      each failure back to a sub-question id (section headings
 *      are rendered as `## <sq.question>`), re-invoke
 *      `runSectionSynth` with a narrow structural nudge for each
 *      affected section, then re-run `runSynthMerge` composing
 *      the refreshed sections with the un-touched ones (loaded
 *      from their existing on-disk snapshots via synthetic `ok`
 *      outcomes).
 *
 *   2. **Structural failures without a section hint, or subjective
 *      failures.** No per-section re-synth. We call
 *      `runSynthMerge` with the nudge appended to the merge prompt
 *      so the intro / conclusion / ordering are rewritten. This
 *      handles:
 *      - `no-unresolved-placeholders`, `no-bare-urls-in-body`,
 *        `no-duplicate-footnote-ids` - global post-merge text
 *        hygiene issues.
 *      - `every-sub-question-has-section` - merge re-runs
 *        `loadSectionBody` for each sub-question, so a previously-
 *        missing section either resurfaces from disk or gets a
 *        stub.
 *      - critic verdict issues - subjective polish live in the
 *        merge prompt anyway.
 *
 * Why not re-run `runAllSections` for the whole plan? Cost and
 * determinism. A per-section retarget keeps the refinement cheap
 * and preserves sections the structural check was happy with. The
 * cost of the merge pass is fixed either way.
 *
 * This module is pure - it consumes a caller-supplied session and
 * never loads pi's extension APIs. Tests inject a mocked session
 * factory and scripted `callTyped` replies to verify the mapping
 * logic, the nudge formatting, and the end-to-end disk state.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type StructuralFailure } from './deep-research-structural-check.ts';
import { runSynthMerge, type SynthMergeResult } from './deep-research-synth-merge.ts';
import { type SectionOutcome, runSectionSynth } from './deep-research-synth-sections.ts';
import { type Issue, type Verdict } from './iteration-loop-schema.ts';
import { appendJournal } from './research-journal.ts';
import { paths } from './research-paths.ts';
import { type DeepResearchPlan } from './research-plan.ts';
import { listRun, type SourceRef } from './research-sources.ts';
import { type ResearchSessionLike } from './research-structured.ts';
import { type TinyAdapter, type TinyCallContext } from './research-tiny.ts';

// ──────────────────────────────────────────────────────────────────────
// Public types.
// ──────────────────────────────────────────────────────────────────────

export interface RefineReportArgs<M> {
  runRoot: string;
  plan: DeepResearchPlan;
  stage: 'structural' | 'subjective';
  /** Populated on `stage === 'structural'`. */
  structural?: readonly StructuralFailure[];
  /** Populated on `stage === 'subjective'`. */
  critic?: Verdict;
  /** 1-indexed iteration number, used purely for journaling. */
  iteration: number;
  /** Parent session used to drive synth + merge turns. */
  session: ResearchSessionLike;
  model: string;
  thinkingLevel: string | null;
  /** Shared source index; optional - we call listRun if omitted. */
  sourceIndex?: readonly SourceRef[];
  /** Sub-question ids whose findings were quarantined upstream. */
  quarantinedFindings?: ReadonlySet<string>;
  /** Test clock. */
  now?: () => Date;
  /** Optional tiny adapter (error humanization + provenance summary). */
  tinyAdapter?: TinyAdapter<M>;
  tinyCtx?: TinyCallContext<M>;
  /** `callTyped` attempt cap per section/merge call. Default 3. */
  maxRetries?: number;
}

export interface RefineReportResult {
  /** Sub-question ids that were re-synthesized this refinement. */
  refinedSections: string[];
  /** Merge result, including the absolute `reportPath`. */
  merge: SynthMergeResult;
  /** True when we had to re-run the merge only (no per-section path). */
  mergeOnly: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Pure logic: mapping failures → sub-questions.
// ──────────────────────────────────────────────────────────────────────

/**
 * Structural check ids we know how to refine by re-running a
 * specific section. Everything else falls through to the
 * merge-only path.
 *
 * `every-section-cites-a-source` is the primary driver - it
 * carries a `location === sq.question` that maps cleanly back to
 * a sub-question. The marker-resolution ids are included here
 * opportunistically: a re-synth of the owning section often fixes
 * a stray `[^n]` or a missing footnote-URL lookup because the
 * section rewrites its own source set.
 */
const SECTION_REFINABLE_IDS = new Set([
  'every-section-cites-a-source',
  'footnote-markers-resolve',
  'footnote-urls-in-store',
]);

export interface SectionRefinementTarget {
  subQuestionId: string;
  /** Human-readable nudge tailored to the specific failures. */
  nudge: string;
  /** The failures that drove this target (for journaling). */
  failures: readonly StructuralFailure[];
}

/**
 * Inspect structural failures and return one refinement target per
 * affected sub-question. Failures whose location matches a
 * sub-question question string are grouped together; failures
 * with no location (global / body-wide) are skipped and handled
 * by the merge-only fallback.
 *
 * Exported for testing.
 */
export function mapStructuralFailuresToTargets(
  failures: readonly StructuralFailure[],
  plan: DeepResearchPlan,
): SectionRefinementTarget[] {
  const byQuestion = new Map<string, StructuralFailure[]>();
  for (const f of failures) {
    if (!SECTION_REFINABLE_IDS.has(f.id)) continue;
    if (!f.location || f.location.trim().length === 0) continue;
    const sq = plan.subQuestions.find((x) => x.question === f.location);
    if (!sq) continue;
    const bucket = byQuestion.get(sq.id) ?? [];
    bucket.push(f);
    byQuestion.set(sq.id, bucket);
  }
  const targets: SectionRefinementTarget[] = [];
  for (const [subQuestionId, sectionFailures] of byQuestion) {
    targets.push({
      subQuestionId,
      nudge: buildSectionNudge(sectionFailures),
      failures: sectionFailures,
    });
  }
  return targets;
}

/**
 * Compose a terse nudge string describing the failures the synth
 * must address. Kept short (≤ ~400 chars) so it doesn't dwarf the
 * actual section prompt.
 */
export function buildSectionNudge(failures: readonly StructuralFailure[]): string {
  const bullets = failures.map((f) => {
    const loc = f.location ? ` (at ${f.location})` : '';
    return `- [${f.id}]${loc}: ${f.message}`;
  });
  return [
    'The previous draft of this section failed the structural check. Specific issues:',
    ...bullets,
    '',
    'Rewrite the section so every substantive claim ends with a {{SRC:<id>}} ' +
      'placeholder drawn from the allowed source list above. Do not invent ids. ' +
      'If no source in the list can support a claim, drop the claim.',
  ].join('\n');
}

/**
 * Compose a merge-stage nudge that echoes the structural failures
 * we could not pin to a single section. Used in the merge-only
 * path so the intro/conclusion/ordering get a chance to fix
 * global structural issues.
 */
export function buildStructuralMergeNudge(failures: readonly StructuralFailure[]): string {
  if (failures.length === 0) return '';
  const bullets = failures.map((f) => {
    const loc = f.location ? ` (at ${f.location})` : '';
    return `- [${f.id}]${loc}: ${f.message}`;
  });
  return [
    'The previous draft of the report failed the structural check with issues the per-section refinement cannot address. Specific issues:',
    ...bullets,
    '',
    'Tighten the intro, conclusion, and section ordering so these issues do not recur. Do NOT introduce new footnote markers or source ids in the intro/conclusion - those come from the section bodies.',
  ].join('\n');
}

/**
 * Compose a merge-stage nudge from a subjective critic verdict.
 * Uses the verdict's `summary` + per-issue descriptions, trimmed
 * so the merge prompt stays under the model's context cap.
 */
export function buildSubjectiveNudge(verdict: Verdict): string {
  const issues: readonly Issue[] = verdict.issues ?? [];
  const bullets = issues.map((i) => {
    const sev = i.severity ? `[${i.severity}] ` : '';
    return `- ${sev}${truncate(i.description, 240)}`;
  });
  const summaryLine = verdict.summary ? truncate(verdict.summary, 240) : '(no summary)';
  return [
    'The previous draft of the report failed the subjective critic. Summary:',
    summaryLine,
    '',
    bullets.length > 0 ? 'Issues to address:' : 'No itemized issues were provided.',
    ...bullets,
    '',
    'Keep all citations and sub-question section bodies intact; refine the title, intro, conclusion, and ordering so the report reads as a cohesive whole and addresses the issues above.',
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Refinement driver.
// ──────────────────────────────────────────────────────────────────────

/**
 * Top-level refinement entry. Picks the per-section path or the
 * merge-only path based on the failures, re-runs synth + merge as
 * needed, and returns the result. Journal entries at every
 * boundary so a post-hoc run reviewer can see exactly what
 * refinement did.
 */
export async function refineReport<M>(args: RefineReportArgs<M>): Promise<RefineReportResult> {
  const p = paths(args.runRoot);
  const sourceIndex = args.sourceIndex ?? listRun(args.runRoot);

  if (args.stage === 'subjective') {
    return refineMergeOnly(args, sourceIndex, buildSubjectiveNudge(args.critic ?? emptyVerdict()));
  }

  // Structural.
  const failures = args.structural ?? [];
  const targets = mapStructuralFailuresToTargets(failures, args.plan);

  if (targets.length === 0) {
    const nudge = buildStructuralMergeNudge(failures);
    return refineMergeOnly(args, sourceIndex, nudge);
  }

  // Per-section refinement. Run sections in order to keep the
  // journal narrative linear.
  const refinedOutcomes = new Map<string, SectionOutcome>();
  for (const target of targets) {
    try {
      appendJournal(p.journal, {
        level: 'step',
        heading: `refinement: re-synthesizing section ${target.subQuestionId} (iter ${args.iteration})`,
        body: target.nudge,
      });
    } catch {
      /* swallow */
    }
    const outcome = await runSectionSynth<M>({
      runRoot: args.runRoot,
      plan: args.plan,
      subQuestionId: target.subQuestionId,
      session: args.session,
      model: args.model,
      thinkingLevel: args.thinkingLevel,
      extraInstructions: target.nudge,
      sourceIndex,
      journalPath: p.journal,
      ...(args.quarantinedFindings ? { quarantinedFindings: args.quarantinedFindings } : {}),
      ...(args.now ? { now: args.now } : {}),
      ...(args.maxRetries !== undefined ? { maxRetries: args.maxRetries } : {}),
      ...(args.tinyAdapter ? { tinyAdapter: args.tinyAdapter } : {}),
      ...(args.tinyCtx ? { tinyCtx: args.tinyCtx } : {}),
    });
    refinedOutcomes.set(target.subQuestionId, outcome);
  }

  // Build the full SectionOutcome list: refined outcomes for the
  // targeted sub-questions, synthetic `ok` outcomes for the rest
  // (so `runSynthMerge` reads their bodies off disk).
  const allOutcomes = composeSectionOutcomes(args.plan, args.runRoot, refinedOutcomes);

  try {
    appendJournal(p.journal, {
      level: 'step',
      heading: `refinement: re-merging after re-synthesizing ${refinedOutcomes.size} section(s) (iter ${args.iteration})`,
    });
  } catch {
    /* swallow */
  }

  const merge = await runSynthMerge<M>({
    runRoot: args.runRoot,
    plan: args.plan,
    sectionOutcomes: allOutcomes,
    session: args.session,
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    sourceIndex,
    journalPath: p.journal,
    ...(args.now ? { now: args.now } : {}),
    ...(args.maxRetries !== undefined ? { maxRetries: args.maxRetries } : {}),
    ...(args.tinyAdapter ? { tinyAdapter: args.tinyAdapter } : {}),
    ...(args.tinyCtx ? { tinyCtx: args.tinyCtx } : {}),
  });

  return {
    refinedSections: Array.from(refinedOutcomes.keys()),
    merge,
    mergeOnly: false,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Internals.
// ──────────────────────────────────────────────────────────────────────

async function refineMergeOnly<M>(
  args: RefineReportArgs<M>,
  sourceIndex: readonly SourceRef[],
  nudge: string,
): Promise<RefineReportResult> {
  const p = paths(args.runRoot);
  try {
    appendJournal(p.journal, {
      level: 'step',
      heading: `refinement: merge-only re-run (stage=${args.stage}, iter ${args.iteration})`,
      body: nudge.length > 0 ? nudge : '(no nudge - empty verdict)',
    });
  } catch {
    /* swallow */
  }

  const outcomes = composeSectionOutcomes(args.plan, args.runRoot, new Map());
  const merge = await runSynthMerge<M>({
    runRoot: args.runRoot,
    plan: args.plan,
    sectionOutcomes: outcomes,
    session: args.session,
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    sourceIndex,
    journalPath: p.journal,
    ...(nudge.length > 0 ? { extraInstructions: nudge } : {}),
    ...(args.now ? { now: args.now } : {}),
    ...(args.maxRetries !== undefined ? { maxRetries: args.maxRetries } : {}),
    ...(args.tinyAdapter ? { tinyAdapter: args.tinyAdapter } : {}),
    ...(args.tinyCtx ? { tinyCtx: args.tinyCtx } : {}),
  });

  return { refinedSections: [], merge, mergeOnly: true };
}

/**
 * Compose a `SectionOutcome[]` for `runSynthMerge`: use the
 * refreshed outcome if present, else build a synthetic `ok`
 * outcome pointing at the existing snapshot on disk (merge's
 * `loadSectionBody` reads from `sectionPath` when the in-memory
 * `markdown` field is empty). Sub-questions with no snapshot get
 * a `missing-finding` outcome so merge renders a stub.
 */
function composeSectionOutcomes(
  plan: DeepResearchPlan,
  runRoot: string,
  refined: ReadonlyMap<string, SectionOutcome>,
): SectionOutcome[] {
  const p = paths(runRoot);
  const sectionsDir = join(p.snapshots, 'sections');
  return plan.subQuestions.map((sq) => {
    const refreshed = refined.get(sq.id);
    if (refreshed) return refreshed;
    const sectionPath = join(sectionsDir, `${sq.id}.md`);
    if (!existsSync(sectionPath)) {
      // No snapshot on disk - either the initial synth phase
      // produced a stuck / missing-finding outcome for this
      // sub-question, or the fanout subagent never wrote a
      // finding for it. Either way there's nothing to compose
      // from; merge will render a `[section unavailable: …]`
      // stub using this reason. Keep the message short and
      // user-facing - the absolute path the previous revision
      // included added zero signal for the reader.
      return {
        kind: 'missing-finding' as const,
        subQuestionId: sq.id,
        reason: 'no section snapshot on disk at refinement time (initial synth produced no body)',
      };
    }
    // Read in eagerly so merge's in-memory path wins (cheaper and
    // avoids a second disk read inside loadSectionBody).
    let markdown = '';
    try {
      markdown = readFileSync(sectionPath, 'utf8');
    } catch {
      markdown = '';
    }
    return {
      kind: 'ok' as const,
      subQuestionId: sq.id,
      sectionPath,
      markdown,
      sourceIds: [],
      truncated: false,
    };
  });
}

function emptyVerdict(): Verdict {
  return { approved: false, score: 0, issues: [], summary: '(no verdict provided)' };
}

function truncate(s: string | undefined, cap: number): string {
  if (!s) return '';
  if (s.length <= cap) return s;
  return `${s.slice(0, cap - 1)}…`;
}
