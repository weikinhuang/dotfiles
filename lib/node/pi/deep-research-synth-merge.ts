/* Read "Internals" at the bottom — public API comes first. The
 * `no-use-before-define` rule is disabled at the file scope because
 * TS function declarations are hoisted and this ordering reads
 * top-down (public API → helpers). */
/* eslint-disable no-use-before-define */

/**
 * Merge pass for deep-research synthesis.
 *
 * Glue pass that takes the per-sub-question section files written
 * by `deep-research-synth-sections` and composes a single
 * `report.md` under the run root. Flow:
 *
 *   1. For every sub-question in `plan.subQuestions` order, load
 *      the corresponding `snapshots/sections/<id>.md` body (or
 *      emit a visible `[section unavailable: <reason>]` stub when
 *      the section was quarantined / stuck / missing).
 *   2. Drive one `research-structured.callTyped` turn to produce a
 *      short title + intro + conclusion, with bounded context
 *      (section headings + brief leads + plan metadata; NO raw
 *      findings). Deterministic fallback when the call exhausts
 *      retries or emits `stuck`.
 *   3. Concatenate title → intro → sections → conclusion.
 *   4. Validate every `{{SRC:<id>}}` placeholder against the
 *      run's source store (via `research-citations.validatePlaceholders`).
 *      Unknown ids fail HARD — we refuse to render a draft with a
 *      hallucinated source, matching the plan's Risks section:
 *      "research-citations REJECTS the draft if any placeholder
 *      references an unknown ID".
 *   5. Renumber placeholders into `[^n]` footnote markers via
 *      `research-citations.renumber` and append the footnotes block.
 *   6. Write `report.md` atomically, with a provenance sidecar.
 *
 * Bounded context: the merge prompt sees only section headings +
 * brief leads + plan metadata. Raw findings never leave the synth
 * stage.
 *
 * Robustness posture (see `research-extensions-robustness-principle`):
 *
 *   - `callTyped` nudge + retry + fallback on merge metadata.
 *   - Structure check (`validatePlaceholders`) is a hard gate
 *     between synth output and the rendered report — a
 *     hallucinated `{{SRC:...}}` throws a typed
 *     {@link UnknownPlaceholderError} the caller surfaces to the
 *     journal, never silently renders a dangling citation.
 *   - Missing / quarantined sections produce visible stubs rather
 *     than being omitted silently, so the structural check in
 *     Phase 4 can count sub-questions + sections and notice
 *     mismatches.
 *
 * Optional tiny-model integrations:
 *
 *   - `callTyped` validation-error humanization (same pattern as
 *     planner / self-critic / synth-sections).
 *   - Provenance summary on the report sidecar.
 *
 * No pi imports.
 */

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteFile, ensureDirSync } from './atomic-write.ts';
import { type SectionOutcome } from './deep-research-synth-sections.ts';
import { renumber, type CitationSource, validatePlaceholders } from './research-citations.ts';
import { appendJournal } from './research-journal.ts';
import { paths } from './research-paths.ts';
import { type DeepResearchPlan, type SubQuestion } from './research-plan.ts';
import { hashPrompt, type Provenance, writeSidecar } from './research-provenance.ts';
import { listRun, type SourceRef } from './research-sources.ts';
import { callTyped, type ResearchSessionLike, type SchemaLike } from './research-structured.ts';
import { isStuckShape } from './research-stuck.ts';
import { type TinyAdapter, tinyProvenanceSummary, type TinyCallContext } from './research-tiny.ts';
import { isRecord } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Errors.
// ──────────────────────────────────────────────────────────────────────

/**
 * Thrown by {@link runSynthMerge} when the assembled draft still
 * contains `{{SRC:<id>}}` placeholders referencing ids that are
 * not in the source store. The synth stage's validator already
 * catches this per-section in-session; this error fires when an
 * out-of-band edit (e.g. a user manually editing a section file,
 * or a test injecting a bad placeholder) slips a bad id past the
 * synth gate.
 *
 * Surfacing as a typed error (instead of writing a broken report)
 * keeps the "research-citations REJECTS draft with unknown id"
 * contract load-bearing.
 */
export class UnknownPlaceholderError extends Error {
  public readonly unknown: readonly string[];

  constructor(unknown: readonly string[]) {
    super(`research-citations: unknown source ids cited: ${unknown.join(', ')}`);
    this.name = 'UnknownPlaceholderError';
    this.unknown = unknown;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Merge-output schema.
// ──────────────────────────────────────────────────────────────────────

/**
 * What the merge LLM turn emits: a brief title + introductory
 * paragraphs + concluding paragraph. Sections ARE NOT regenerated
 * here — the synth stage already wrote them. This turn exists so
 * the report has a cohesive wrapper, not so it rewrites content.
 */
export interface MergeOutput {
  title: string;
  introduction: string;
  conclusion: string;
}

/** Hard caps for each merge-output field. Generous but bounded. */
const MERGE_TITLE_MAX = 200;
const MERGE_INTRO_MAX = 2500;
const MERGE_CONCLUSION_MAX = 2000;

export const mergeOutputSchema: SchemaLike<MergeOutput> = {
  validate(v) {
    if (!isRecord(v)) return { ok: false, error: 'root value must be an object' };
    const title = v.title;
    const intro = v.introduction;
    const conclusion = v.conclusion;
    if (typeof title !== 'string' || title.trim().length === 0) {
      return { ok: false, error: 'title must be a non-empty string' };
    }
    if (title.length > MERGE_TITLE_MAX) {
      return { ok: false, error: `title must be ≤ ${MERGE_TITLE_MAX} chars (got ${title.length})` };
    }
    if (typeof intro !== 'string' || intro.trim().length === 0) {
      return { ok: false, error: 'introduction must be a non-empty string' };
    }
    if (intro.length > MERGE_INTRO_MAX) {
      return { ok: false, error: `introduction must be ≤ ${MERGE_INTRO_MAX} chars (got ${intro.length})` };
    }
    if (typeof conclusion !== 'string' || conclusion.trim().length === 0) {
      return { ok: false, error: 'conclusion must be a non-empty string' };
    }
    if (conclusion.length > MERGE_CONCLUSION_MAX) {
      return {
        ok: false,
        error: `conclusion must be ≤ ${MERGE_CONCLUSION_MAX} chars (got ${conclusion.length})`,
      };
    }
    return { ok: true, value: { title: title.trim(), introduction: intro.trim(), conclusion: conclusion.trim() } };
  },
};

// ──────────────────────────────────────────────────────────────────────
// Prompt.
// ──────────────────────────────────────────────────────────────────────

/**
 * Render the merge prompt. Bounded context: we pass in only the
 * plan question, the ordered list of sub-questions + a tiny lead
 * line from each rendered section (never the whole section body,
 * never raw findings). That keeps the merge call cheap and
 * prevents the model from inadvertently paraphrasing sections
 * into the intro/conclusion.
 */
export function renderMergePrompt(
  plan: DeepResearchPlan,
  sectionLeads: readonly SectionLead[],
  extraInstructions?: string,
): string {
  const leadLines =
    sectionLeads.length === 0
      ? '  (no sections)'
      : sectionLeads
          .map((l) => `  - id=${l.subQuestionId} question=${JSON.stringify(l.question)} lead=${JSON.stringify(l.lead)}`)
          .join('\n');

  const extra =
    extraInstructions && extraInstructions.trim().length > 0
      ? [
          '',
          'Additional instructions from the review loop (a prior attempt failed; address these specifically this time):',
          extraInstructions.trim(),
        ]
      : [];

  return [
    `You are writing the wrapper for a /research report.`,
    `User question: ${plan.question}`,
    '',
    `Sub-question sections (already written; do NOT rewrite their content):`,
    leadLines,
    '',
    `Emit JSON with these fields:`,
    `{`,
    `  "title": "<short report title, ≤ ${MERGE_TITLE_MAX} chars>",`,
    `  "introduction": "<1-3 paragraph introduction framing the question and covering what the sections address; ≤ ${MERGE_INTRO_MAX} chars>",`,
    `  "conclusion": "<1 paragraph conclusion summarizing the findings at a high level; ≤ ${MERGE_CONCLUSION_MAX} chars>"`,
    `}`,
    '',
    `Requirements:`,
    `- Do NOT cite sources in the intro or conclusion; those come from the section bodies.`,
    `- Do NOT emit {{SRC:...}} placeholders or [^n] footnote markers.`,
    `- Do NOT paraphrase whole sections; refer to them by sub-question.`,
    `- If you cannot produce a cohesive wrapper, emit {"status":"stuck","reason":"..."} and we will fall back.`,
    `- Reply with JSON only. No prose preamble. No markdown fences.`,
    ...extra,
  ].join('\n');
}

/** Per-section summary fed into the merge prompt. */
export interface SectionLead {
  subQuestionId: string;
  question: string;
  /** First non-empty non-heading line of the section body. */
  lead: string;
}

// ──────────────────────────────────────────────────────────────────────
// Public entry: runSynthMerge.
// ──────────────────────────────────────────────────────────────────────

export interface SynthMergeOpts<M> {
  runRoot: string;
  plan: DeepResearchPlan;
  /**
   * Per-sub-question outcomes from the synth stage. Ordering in
   * the final report follows `plan.subQuestions`, NOT the order of
   * this array — outcomes are looked up by id.
   */
  sectionOutcomes: readonly SectionOutcome[];
  /**
   * Parent session. Shares the planner / self-critic / synth
   * session by default. Merge only drives one additional turn.
   */
  session: ResearchSessionLike;
  model: string;
  thinkingLevel: string | null;
  /** Test clock. */
  now?: () => Date;
  /** `callTyped` attempt cap. Default 3. */
  maxRetries?: number;
  /** Journal path; swallowed on missing dir. */
  journalPath?: string;
  /**
   * Pre-loaded source index. Optional — we fall back to
   * `research-sources.listRun(runRoot)`. Lets the driver share
   * the index with synth-sections so the store is walked once.
   */
  sourceIndex?: readonly SourceRef[];
  /** Optional tiny adapter — error humanization + provenance summary. */
  tinyAdapter?: TinyAdapter<M>;
  tinyCtx?: TinyCallContext<M>;
  /**
   * Optional extra instructions appended verbatim to the merge
   * prompt. Used by the review-loop refinement path to thread a
   * subjective-critic nudge into the re-merge without having to
   * open up `callTyped` or change the core prompt shape.
   */
  extraInstructions?: string;
}

export interface SynthMergeResult {
  /** Absolute path to the emitted report. */
  reportPath: string;
  /**
   * Number of footnotes in the rendered report. Zero when no
   * known sources were cited. Useful for the caller's summary
   * notification.
   */
  footnoteCount: number;
  /**
   * Sub-question ids whose section was not usable (quarantined,
   * stuck, or missing-finding) and surfaced as a stub in the
   * report. Empty array on the happy path.
   */
  stubbedSubQuestions: string[];
  /**
   * True when the merge LLM turn exhausted retries (or emitted
   * `stuck`) and the deterministic intro/conclusion fallback was
   * used instead. The report is still rendered in this case.
   */
  usedFallback: boolean;
}

/**
 * Drive the merge stage end-to-end. Throws
 * {@link UnknownPlaceholderError} when the assembled draft
 * references an id not present in the source store; all other
 * failure paths (missing section, exhausted merge call, stuck
 * model) are handled in-band and never throw.
 */
export async function runSynthMerge<M>(opts: SynthMergeOpts<M>): Promise<SynthMergeResult> {
  const p = paths(opts.runRoot);
  ensureDirSync(opts.runRoot);

  // ── 1. Load each section. ─────────────────────────────────────
  const outcomeById = new Map(opts.sectionOutcomes.map((o) => [o.subQuestionId, o]));
  const orderedSections: { sq: SubQuestion; body: string; stubbed: boolean; stubReason?: string }[] = [];
  const stubbed: string[] = [];
  for (const sq of opts.plan.subQuestions) {
    const outcome = outcomeById.get(sq.id);
    const loaded = loadSectionBody(sq, outcome);
    if (loaded.stubbed) stubbed.push(sq.id);
    orderedSections.push({
      sq,
      body: loaded.body,
      stubbed: loaded.stubbed,
      ...(loaded.reason ? { stubReason: loaded.reason } : {}),
    });
  }

  // ── 2. Merge LLM turn (title + intro + conclusion). ───────────
  const leads: SectionLead[] = orderedSections.map((s) => ({
    subQuestionId: s.sq.id,
    question: s.sq.question,
    lead: firstParagraphLead(s.body),
  }));
  const mergePrompt = renderMergePrompt(opts.plan, leads, opts.extraInstructions);
  const FALLBACK_SENTINEL: MergeOutput = { title: '', introduction: '', conclusion: '' };

  const onRetry = buildOnRetry(opts);
  const typed = await callTyped<MergeOutput>({
    session: opts.session,
    prompt: mergePrompt,
    schema: mergeOutputSchema,
    fallback: () => FALLBACK_SENTINEL,
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(onRetry ? { onRetry } : {}),
  });

  const deterministic = buildDeterministicMerge(opts.plan);
  let meta: MergeOutput;
  let usedFallback = false;
  if (isStuckShape(typed)) {
    journalIf(opts, 'warn', `merge emitted stuck — using deterministic wrapper`, typed.reason);
    meta = deterministic;
    usedFallback = true;
  } else if (typed === FALLBACK_SENTINEL) {
    journalIf(opts, 'warn', `merge retries exhausted — using deterministic wrapper`);
    meta = deterministic;
    usedFallback = true;
  } else {
    meta = typed;
  }

  // ── 3. Assemble draft. ────────────────────────────────────────
  const draft = composeDraft({ plan: opts.plan, sections: orderedSections, meta });

  // ── 4. Validate placeholders against the source store. ────────
  const sourceIndex = opts.sourceIndex ?? listRun(opts.runRoot);
  const knownIds = new Set(sourceIndex.map((s) => s.id));
  const validation = validatePlaceholders(draft, knownIds);
  if (!validation.ok) {
    throw new UnknownPlaceholderError(validation.unknown);
  }

  // ── 5. Renumber → footnotes. ──────────────────────────────────
  const citationIndex = new Map<string, CitationSource>(
    sourceIndex.map((s) => [s.id, { id: s.id, url: s.url, title: s.title }]),
  );
  const { report, footnotes } = renumber(draft, citationIndex);
  const finalBody = footnotes.length > 0 ? `${report.replace(/\s+$/, '')}\n\n${footnotes}` : report;
  const withTrailingNewline = finalBody.endsWith('\n') ? finalBody : finalBody + '\n';

  // ── 6. Write report + provenance. ─────────────────────────────
  atomicWriteFile(p.report, withTrailingNewline);
  const summary = await tinyProvenanceSummary(
    opts.tinyAdapter,
    opts.tinyCtx,
    renderSummaryExcerpt(opts.plan, mergePrompt),
  );
  const provenance: Provenance = {
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    timestamp: (opts.now ? opts.now() : new Date()).toISOString(),
    promptHash: hashPrompt(mergePrompt),
    ...(summary ? { summary } : {}),
  };
  writeSidecar(p.report, provenance);

  journalIf(
    opts,
    'step',
    `merge wrote report.md`,
    `sections=${orderedSections.length} stubbed=${stubbed.length} footnotes=${countFootnotes(finalBody)} fallback=${usedFallback}`,
  );

  return {
    reportPath: p.report,
    footnoteCount: countFootnotes(finalBody),
    stubbedSubQuestions: stubbed,
    usedFallback,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Internals.
// ──────────────────────────────────────────────────────────────────────

function journalIf<M>(
  opts: SynthMergeOpts<M>,
  level: 'info' | 'step' | 'warn' | 'error',
  heading: string,
  body?: string,
): void {
  if (!opts.journalPath) return;
  if (!existsSync(opts.runRoot)) return;
  try {
    appendJournal(opts.journalPath, body !== undefined ? { level, heading, body } : { level, heading });
  } catch {
    /* swallow */
  }
}

function buildOnRetry<M>(opts: SynthMergeOpts<M>): ((err: string, n: number) => void) | undefined {
  const adapter = opts.tinyAdapter;
  const ctx = opts.tinyCtx;
  if (!adapter || !ctx || !adapter.isEnabled()) return undefined;
  return (error, attempt) => {
    void adapter
      .callTinyRewrite(ctx, 'humanize-error', error)
      .then((humanized) => {
        if (typeof humanized === 'string' && humanized.trim().length > 0) {
          journalIf(opts, 'info', `merge validation nudge humanized (attempt ${attempt})`, humanized);
        }
      })
      .catch(() => {
        /* swallow */
      });
  };
}

/**
 * Load the section body for `sq` given its synth outcome. The
 * outcome tells us whether the section is usable (`ok`) or needs
 * a visible stub (`quarantined`/`stuck`/`missing-finding`). When
 * the outcome is `ok` we prefer the outcome's in-memory markdown
 * over re-reading the snapshot file, so tests using the pure
 * pipeline (no disk roundtrip) still work.
 */
function loadSectionBody(
  sq: SubQuestion,
  outcome: SectionOutcome | undefined,
): { body: string; stubbed: boolean; reason?: string } {
  if (!outcome) {
    return {
      body: formatStub(sq, 'no synth outcome recorded'),
      stubbed: true,
      reason: 'no synth outcome recorded',
    };
  }
  if (outcome.kind === 'ok') {
    // Prefer in-memory body; fall back to on-disk read if needed.
    if (outcome.markdown.trim().length > 0) {
      return { body: ensureHeading(outcome.markdown, sq), stubbed: false };
    }
    if (existsSync(outcome.sectionPath)) {
      try {
        return { body: ensureHeading(readFileSync(outcome.sectionPath, 'utf8'), sq), stubbed: false };
      } catch {
        /* fall through to stub */
      }
    }
    return { body: formatStub(sq, 'section body empty'), stubbed: true, reason: 'section body empty' };
  }
  return {
    body: formatStub(sq, outcome.reason),
    stubbed: true,
    reason: outcome.reason,
  };
}

/**
 * Emit a visible stub for a sub-question with no usable section.
 * The leading `## ` heading matches the synth stage's own heading
 * shape so the structural check's "every sub-question is a
 * section" rule fires on the stub too.
 */
export function formatStub(sq: SubQuestion, reason: string): string {
  const safeReason = reason.replace(/[\r\n]+/g, ' ').trim() || 'unknown';
  return `## ${sq.question}\n\n[section unavailable: ${safeReason}]\n`;
}

/**
 * Ensure the section body opens with a `## ` heading. Synth is
 * instructed to do this, but we make it idempotent so a stripped
 * body still renders as a section.
 */
function ensureHeading(body: string, sq: SubQuestion): string {
  const trimmed = body.replace(/^\s+/, '');
  if (trimmed.startsWith('## ')) return trimmed.replace(/\s+$/, '') + '\n';
  return `## ${sq.question}\n\n${trimmed.replace(/\s+$/, '')}\n`;
}

/**
 * First non-empty non-heading line of the section, trimmed to a
 * short lead. Feeds the merge prompt so the model knows roughly
 * what each section covers without seeing the full body.
 */
function firstParagraphLead(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0) continue;
    if (t.startsWith('#')) continue;
    if (t.startsWith('[section unavailable')) return t;
    return t.length > 200 ? t.slice(0, 200) + '…' : t;
  }
  return '';
}

/**
 * Deterministic wrapper used when the merge LLM turn exhausts
 * retries or emits `stuck`. Keeps the report shipping even when
 * the glue call fails — matches the robustness principle's "the
 * fallback is a narrower-but-valid result, not a silent skip".
 */
function buildDeterministicMerge(plan: DeepResearchPlan): MergeOutput {
  const n = plan.subQuestions.length;
  const questionsList =
    n === 0 ? '(no sub-questions were planned)' : plan.subQuestions.map((sq) => `  - ${sq.question}`).join('\n');
  return {
    title: `Research: ${plan.question}`.slice(0, MERGE_TITLE_MAX),
    introduction: [
      `This report addresses the research question: ${plan.question}.`,
      '',
      `It synthesizes findings across ${n} sub-question${n === 1 ? '' : 's'}:`,
      questionsList,
    ]
      .join('\n')
      .slice(0, MERGE_INTRO_MAX),
    conclusion: [
      `See the sub-question sections above for the detailed, cited findings.`,
      `Contradictions or gaps between sources — if any — are flagged inline in the relevant section.`,
    ]
      .join(' ')
      .slice(0, MERGE_CONCLUSION_MAX),
  };
}

/**
 * Assemble the full draft (pre-renumber). Order:
 *
 *     # <title>
 *     <intro>
 *     <section 1>
 *     <section 2>
 *     ...
 *     ## Conclusion
 *     <conclusion>
 *
 * Every section block is separated from the next by a single
 * blank line.
 */
function composeDraft(args: {
  plan: DeepResearchPlan;
  sections: { sq: SubQuestion; body: string; stubbed: boolean; stubReason?: string }[];
  meta: MergeOutput;
}): string {
  const parts: string[] = [];
  parts.push(`# ${args.meta.title.trim()}`);
  parts.push('');
  parts.push(args.meta.introduction.trim());
  for (const s of args.sections) {
    parts.push('');
    parts.push(s.body.trim());
  }
  parts.push('');
  parts.push('## Conclusion');
  parts.push('');
  parts.push(args.meta.conclusion.trim());
  return parts.join('\n') + '\n';
}

/**
 * Cheap footnote counter used for the journal line. Not a
 * structural check — that's Phase 4's job.
 */
function countFootnotes(report: string): number {
  const matches = report.match(/^\[\^[0-9]+\]:/gm);
  return matches ? matches.length : 0;
}

/**
 * Build the short excerpt handed to `tinyProvenanceSummary` for
 * the report sidecar. Only the plan's top-level question + the
 * start of the merge prompt — the tiny helper has a 120-char
 * output cap so there's no value in feeding it the whole
 * prompt.
 */
function renderSummaryExcerpt(plan: DeepResearchPlan, prompt: string): string {
  return `research report for: ${plan.question}\n(${plan.subQuestions.length} sub-questions)\nprompt excerpt: ${prompt.slice(0, 300)}`;
}
