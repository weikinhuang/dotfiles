/**
 * Rubric file emission for deep-research runs.
 *
 * Materialized in the run directory when the plan is first
 * written, these two markdown files carry the rubric surface the
 * Phase 4 two-stage review consumes:
 *
 *   - `rubric-structural.md` is input to the `kind=bash`
 *     deterministic check (`deep-research-structural-check`). Its
 *     bullets are the exact structural invariants the check
 *     enforces — every bullet here corresponds to a deterministic
 *     test we can run without a model.
 *
 *   - `rubric-subjective.md` is input to the `kind=critic` stage
 *     (subjective rubric passed to the `critic` agent via the
 *     iteration-loop). It deliberately does NOT re-list the
 *     structural items — those are already enforced, and asking
 *     the critic to re-judge them wastes tokens + produces noisy
 *     "approved despite structural issue" verdicts.
 *
 * Both files land in the run root (`./research/<slug>/`) and are
 * editable by the user before the review runs — the `memory` +
 * consent flag path will surface a "rubric was edited" nudge in
 * Phase 4, but this module only writes them.
 *
 * Pure module — no pi imports, no subprocess, no LLM.
 */

import { existsSync } from 'node:fs';

import { atomicWriteFile, ensureDirSync } from './atomic-write.ts';
import { paths } from './research-paths.ts';
import { type DeepResearchPlan } from './research-plan.ts';

// ──────────────────────────────────────────────────────────────────────
// Paths.
// ──────────────────────────────────────────────────────────────────────

/**
 * Paths for the two rubric files relative to the run root. Kept
 * as a pair so callers that materialize / audit rubrics don't have
 * to string-join by hand; the canonical run-layout strings live
 * in `research-paths.paths()`, which this helper delegates to.
 */
export interface RubricPaths {
  /** Absolute path to `rubric-structural.md`. */
  structural: string;
  /** Absolute path to `rubric-subjective.md`. */
  subjective: string;
}

/**
 * Derive {@link RubricPaths} from a run root. Thin wrapper over
 * `research-paths.paths()` — exists so callers can express "I
 * need the rubric pair" without reaching into the full `RunPaths`
 * bag.
 */
export function rubricPaths(runRoot: string): RubricPaths {
  const p = paths(runRoot);
  return { structural: p.rubricStructural, subjective: p.rubricSubjective };
}

// ──────────────────────────────────────────────────────────────────────
// Rubric body shapes.
// ──────────────────────────────────────────────────────────────────────

/**
 * Checklist item the structural bash check enforces. Each item is
 * rendered as one bullet in `rubric-structural.md` AND (by the
 * Phase 4 check script) translated into a deterministic test.
 * Keeping both the bullet text and the check id co-located here
 * lets Phase 4 import the same list for test table generation.
 */
export interface StructuralCheckItem {
  /** Stable id. Referenced by the check script when naming failures. */
  id: string;
  /** Bullet text rendered into the rubric markdown. */
  text: string;
}

/**
 * The structural checks the `kind=bash` stage will enforce. Any
 * item added here needs a matching check in Phase 4's
 * `deep-research-structural-check`; any item removed there should
 * come off the list here first.
 */
export const STRUCTURAL_CHECK_ITEMS: readonly StructuralCheckItem[] = [
  {
    id: 'report-exists',
    text: '`report.md` exists under the run root.',
  },
  {
    id: 'footnote-markers-resolve',
    text: 'Every `[^n]` footnote marker in the report body has a matching `[^n]: <title> — <url>` entry in the footnotes block.',
  },
  {
    id: 'footnote-urls-in-store',
    text: "Every footnote URL corresponds to a `sources/<hash>.json` entry in the run's source store.",
  },
  {
    id: 'no-unresolved-placeholders',
    text: 'No unresolved `{{SRC:<id>}}` placeholders remain anywhere in the report.',
  },
  {
    id: 'every-sub-question-has-section',
    text: 'Every sub-question listed in `plan.json` has a corresponding `## ...` section in the report, OR an explicit `[section unavailable: ...]` stub.',
  },
  {
    id: 'no-duplicate-footnote-ids',
    text: 'Footnote numbering is dense and non-duplicated: `[^1]` through `[^N]` with no gaps and no repeats in the footnotes block.',
  },
  {
    id: 'no-bare-urls-in-body',
    text: 'Bare URLs in the body (outside the footnotes block) come from the source store — no hallucinated URLs pasted into prose.',
  },
  {
    id: 'every-section-cites-a-source',
    text: 'Every non-stubbed sub-question section in the report contains at least one `[^n]` footnote marker. An explicit `[section unavailable: …]` stub is the only way a section may legitimately carry zero citations.',
  },
];

// ──────────────────────────────────────────────────────────────────────
// Markdown renderers.
// ──────────────────────────────────────────────────────────────────────

/**
 * Render the structural rubric body. Matches one-check-per-bullet
 * so the Phase 4 check script's failure output can reference
 * line-for-line items.
 */
export function renderStructuralRubric(plan: DeepResearchPlan): string {
  const lines: string[] = [];
  lines.push(`# Structural Rubric — ${plan.slug}`);
  lines.push('');
  lines.push(
    `This rubric is enforced automatically by the Phase 4 ${'`kind=bash`'} structural check. No model judgment — every item below corresponds to a deterministic test.`,
  );
  lines.push('');
  lines.push(`## Checks`);
  lines.push('');
  for (const item of STRUCTURAL_CHECK_ITEMS) {
    lines.push(`- [${item.id}] ${item.text}`);
  }
  lines.push('');
  lines.push(`## Plan context (for human review)`);
  lines.push('');
  lines.push(`- Question: ${plan.question}`);
  lines.push(`- Sub-questions (${plan.subQuestions.length}):`);
  for (const sq of plan.subQuestions) {
    lines.push(`  - \`${sq.id}\` — ${sq.question}`);
  }
  lines.push('');
  lines.push(
    `Edit this file before running \`/research\` only to tighten the structural contract — adding bullets that are NOT deterministically checkable belongs in \`rubric-subjective.md\`.`,
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * Render the subjective rubric body. Consumed by the `kind=critic`
 * stage. Deliberately excludes anything the bash check will catch
 * so the critic doesn't waste tokens re-judging structure.
 */
export function renderSubjectiveRubric(plan: DeepResearchPlan): string {
  const lines: string[] = [];
  lines.push(`# Subjective Rubric — ${plan.slug}`);
  lines.push('');
  lines.push(
    `Used by the Phase 4 ${'`kind=critic`'} stage. Structural items (footnote resolution, placeholder scrubbing, section completeness) are already enforced deterministically — do NOT judge them here.`,
  );
  lines.push('');
  lines.push(`## Rubric`);
  lines.push('');
  lines.push(`- Coverage: does the report address every sub-question in plan.json at a comparable depth?`);
  lines.push(
    `- Citation discipline: every non-trivial claim in a sub-question section is backed by a real source cited from the run's source store (not fabricated, not paraphrased without attribution).`,
  );
  lines.push(
    `- Contradictions surfaced: when two sources disagree, the report notes the disagreement instead of silently picking one.`,
  );
  lines.push(
    `- Scope discipline: the report stays on-topic for the user's question; no sub-question wanders into adjacent material.`,
  );
  lines.push(
    `- Clarity: language is accessible to the target reader, jargon is defined on first use, and claims are concrete enough to act on.`,
  );
  lines.push(
    `- Open questions: the report flags what the researcher could NOT answer from the available sources, so the user knows where to dig deeper.`,
  );
  lines.push('');
  lines.push(`## Plan context (for human review)`);
  lines.push('');
  lines.push(`- Question: ${plan.question}`);
  lines.push(`- Sub-questions (${plan.subQuestions.length}):`);
  for (const sq of plan.subQuestions) {
    lines.push(`  - \`${sq.id}\` — ${sq.question}`);
  }
  lines.push('');
  lines.push(
    `Edit this file before running \`/research\` to add or tighten subjective criteria; anything you want the model to judge goes here.`,
  );
  lines.push('');
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Writer.
// ──────────────────────────────────────────────────────────────────────

export interface WriteRubricOpts {
  /**
   * Run root (`<cwd>/research/<slug>/`). The two rubric files
   * land directly inside this directory.
   */
  runRoot: string;
  /** Plan just materialized. Feeds the context sections of each rubric. */
  plan: DeepResearchPlan;
  /**
   * When true, do not touch files that already exist on disk.
   * Matches the resume / user-edit use case — Phase 4 callers
   * pass this after the user has already edited the rubric. Default
   * is `false` (write unconditionally, overwriting any previous
   * auto-generated content).
   */
  preserveExisting?: boolean;
  /** Hook used by the `preserveExisting` path to test for disk presence. */
  existsSync?: (path: string) => boolean;
}

export interface WriteRubricResult {
  paths: RubricPaths;
  /** Which files were actually written in this call. */
  wrote: { structural: boolean; subjective: boolean };
}

/**
 * Write both rubric files into the run root. Returns the paths so
 * the caller can journal / surface them to the user. Safe to call
 * multiple times; with `preserveExisting: false` (default) every
 * call resets the rubric to the freshly-rendered body.
 */
export function writeRubricFiles(opts: WriteRubricOpts): WriteRubricResult {
  ensureDirSync(opts.runRoot);
  const rp = rubricPaths(opts.runRoot);
  const preserve = opts.preserveExisting === true;
  // Callers may inject `existsSync` to drive the preserve path
  // from tests without touching real files; otherwise we use the
  // statically-imported `node:fs.existsSync`.
  const check = preserve ? (opts.existsSync ?? existsSync) : () => false;

  const wrote = { structural: false, subjective: false };
  if (!check(rp.structural)) {
    atomicWriteFile(rp.structural, renderStructuralRubric(opts.plan));
    wrote.structural = true;
  }
  if (!check(rp.subjective)) {
    atomicWriteFile(rp.subjective, renderSubjectiveRubric(opts.plan));
    wrote.subjective = true;
  }
  return { paths: rp, wrote };
}

// ──────────────────────────────────────────────────────────────────────
// Internals.
// ──────────────────────────────────────────────────────────────────────

// (no internals beyond the imports at the top of the file.)
