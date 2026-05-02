/* Read "Internals" at the bottom — public API comes first. The
 * `no-use-before-define` rule is disabled at the file scope because
 * TS function declarations are hoisted and this ordering reads
 * top-down (public API → helpers). */
/* eslint-disable no-use-before-define */

/**
 * Section-at-a-time synthesis for deep-research.
 *
 * For each sub-question in a completed plan, load ONLY that
 * sub-question's `findings/<id>.md` + the source excerpts the
 * finding references, then drive one `research-structured.callTyped`
 * turn to produce a markdown section body sprinkled with
 * `{{SRC:<src-id>}}` placeholders. The merge stage
 * (`deep-research-synth-merge`) glues the sections together and
 * turns placeholders into footnote markers via
 * `research-citations.renumber`.
 *
 * The module is the pure half of the synth pipeline: a caller-
 * supplied `ResearchSessionLike` drives the LLM; everything else
 * (file I/O, schema validation, quarantine, provenance sidecars,
 * optional tiny-model summaries) lives here.
 *
 * Robustness posture (see `research-extensions-robustness-principle`):
 *
 *   - Every LLM write goes through `callTyped` with retry + nudge
 *     + fallback. The fallback is a `null` sentinel the caller
 *     detects as "no usable section."
 *   - The caller-supplied validator rejects drafts that cite
 *     source ids outside the known set — so the nudge loop also
 *     catches hallucinated citations in-session, before merge ever
 *     sees them.
 *   - Per-section failure is isolated. A section that exhausts
 *     retries (or emits `stuck`, or has no findings on disk) is
 *     reported as `quarantined` / `stuck` / `missing-finding`;
 *     the caller iterates the remaining sub-questions without
 *     aborting. `research-quarantine.quarantine` moves any on-disk
 *     section file under `snapshots/sections/_quarantined/...` so
 *     post-hoc debugging has the raw attempt.
 *   - Bounded context per call: a single sub-question's finding +
 *     its referenced sources. No cross-sub-question pollution.
 *   - Content-length caps: the `findings/<id>.md` body and each
 *     source snippet are truncated before inclusion in the prompt,
 *     and the section's own markdown output is truncated post-
 *     validation. Truncation logs a journal warning; it never
 *     retries.
 *
 * Optional tiny-model integrations:
 *
 *   - `callTyped` validation-error humanization — feeds a friendlier
 *     string into the retry nudge. Best-effort; `null` from the
 *     adapter leaves the raw error in place.
 *   - Provenance `summary` line — one short string describing what
 *     this section covers, attached to the frontmatter of the
 *     section file. Cosmetic; sidecars omit `summary` when the
 *     adapter is off.
 *
 * No pi imports. The extension wires the session + tiny adapter
 * through.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile, ensureDirSync } from './atomic-write.ts';
import { extractFindingSourceUrls } from './deep-research-finding.ts';
import { type CitationSource, validatePlaceholders } from './research-citations.ts';
import { appendJournal } from './research-journal.ts';
import { paths } from './research-paths.ts';
import { type DeepResearchPlan, type SubQuestion } from './research-plan.ts';
import { hashPrompt, type Provenance, writeSidecar } from './research-provenance.ts';
import { quarantine } from './research-quarantine.ts';
import { listRun, normalizeUrl, type SourceRef } from './research-sources.ts';
import { callTyped, type ResearchSessionLike, type SchemaLike } from './research-structured.ts';
import { isStuckShape } from './research-stuck.ts';
import { type TinyAdapter, tinyProvenanceSummary, type TinyCallContext } from './research-tiny.ts';
import { isRecord } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Constants.
// ──────────────────────────────────────────────────────────────────────

/**
 * Hard cap on the markdown produced for a single section, in
 * characters. Translates loosely to the plan's "≤ 1.5k tokens"
 * target. Excess is truncated at the boundary and logged; the
 * cap is not a retry trigger (per plan: caps are "truncation +
 * journal entry, not retry").
 */
export const SECTION_MAX_CHARS = 6000;

/**
 * Per-source excerpt cap fed into the prompt. Keeps the prompt
 * bounded even when the web-researcher cached a large page.
 */
export const SECTION_SOURCE_EXCERPT_CHARS = 1500;

/**
 * Per-finding body cap fed into the prompt. The web-researcher's
 * output is already capped at 4k by `deep-research-finding`, so
 * this is a belt-and-suspenders bound rather than a load-bearing
 * truncation.
 */
export const SECTION_FINDING_BODY_CHARS = 4000;

// ──────────────────────────────────────────────────────────────────────
// Schema.
// ──────────────────────────────────────────────────────────────────────

/**
 * Structured output from the section synth turn. `markdown` is the
 * section body; we do NOT ask for a title / heading separately —
 * the model emits a leading `## <heading>` line inside `markdown`
 * per the prompt's instructions, so merge can concatenate sections
 * without having to reassemble titles.
 */
export interface SectionOutput {
  markdown: string;
}

/**
 * Build a per-call validator that checks (a) the JSON shape and
 * (b) every `{{SRC:<id>}}` placeholder references an id the synth
 * prompt actually advertised as available. We layer the placeholder
 * check into `SchemaLike.validate` (rather than running it
 * post-call) so `callTyped`'s retry-nudge loop catches hallucinated
 * citations in-session. The nudge echoes the specific offending ids
 * back to the model.
 */
export function makeSectionOutputSchema(knownIds: ReadonlySet<string>): SchemaLike<SectionOutput> {
  return {
    validate(v) {
      if (!isRecord(v)) return { ok: false, error: 'root value must be an object' };
      const md = v.markdown;
      if (typeof md !== 'string') return { ok: false, error: 'markdown must be a string' };
      if (md.trim().length === 0) return { ok: false, error: 'markdown must be a non-empty string' };
      const pv = validatePlaceholders(md, knownIds);
      if (!pv.ok) {
        const allow = knownIds.size === 0 ? '(none)' : Array.from(knownIds).join(', ');
        return {
          ok: false,
          error: `unknown source ids cited: ${pv.unknown.join(', ')} (use only {{SRC:<id>}} with id in: ${allow})`,
        };
      }
      return { ok: true, value: { markdown: md } };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Prompt.
// ──────────────────────────────────────────────────────────────────────

/**
 * Render the synth prompt for a single sub-question. Deliberately
 * imperative and short — robustness comes from the nudge loop and
 * the schema validator, not from prompt cleverness.
 *
 * `sources` is the enumeration the validator will accept; the
 * prompt echoes each id + url + title so the model can pick the
 * right one. Empty `sources` is legal (a findings file may cite
 * nothing); the validator will still reject any `{{SRC:...}}`.
 */
export function renderSectionPrompt(
  subQuestion: SubQuestion,
  findingBody: string,
  sources: readonly CitationSource[],
): string {
  const sourceLines =
    sources.length === 0
      ? '  (no sources — do not emit any {{SRC:...}} placeholders)'
      : sources.map((s) => `  - id=${s.id} url=${s.url} title=${s.title || '(untitled)'}`).join('\n');

  return [
    `You are writing one section of a /research report.`,
    `Sub-question id: ${subQuestion.id}`,
    `Sub-question: ${subQuestion.question}`,
    '',
    `Raw findings file (verbatim from the web-researcher):`,
    '```markdown',
    truncate(findingBody, SECTION_FINDING_BODY_CHARS),
    '```',
    '',
    `Available sources you MAY cite. Cite with {{SRC:<id>}} using the id EXACTLY:`,
    sourceLines,
    '',
    `Requirements:`,
    `- Emit JSON with a single field: {"markdown": "<section body>"}`,
    `- The markdown body must start with "## " + a focused heading derived from the sub-question.`,
    `- Every substantive claim ends with a {{SRC:<id>}} placeholder referencing one of the sources listed above.`,
    `- Do NOT cite ids not in the list. Do NOT invent ids.`,
    `- Do NOT emit footnote markers like [^1] — those are added later.`,
    `- Keep the section under ~1500 tokens (~6000 chars).`,
    `- If the findings cannot answer the sub-question, emit {"status":"stuck","reason":"..."} instead of fabricating.`,
    `- Reply with JSON only. No prose preamble. No markdown fences around the JSON.`,
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Public result + opts.
// ──────────────────────────────────────────────────────────────────────

export type SectionOutcome =
  | {
      kind: 'ok';
      subQuestionId: string;
      sectionPath: string;
      markdown: string;
      sourceIds: string[];
      truncated: boolean;
    }
  | { kind: 'missing-finding'; subQuestionId: string; reason: string }
  | { kind: 'stuck'; subQuestionId: string; reason: string }
  | { kind: 'quarantined'; subQuestionId: string; reason: string; movedTo?: string };

export interface SectionSynthOpts<M> {
  runRoot: string;
  plan: DeepResearchPlan;
  subQuestionId: string;
  /**
   * Parent session. Re-used across sections by the top-level
   * driver; each section sends its own prompt, so context
   * accumulates but each prompt is self-contained.
   */
  session: ResearchSessionLike;
  /** Provenance fields recorded on the section sidecar. */
  model: string;
  thinkingLevel: string | null;
  /**
   * Set of sub-question ids whose findings were quarantined
   * upstream (Phase 2's `absorbFindings`). Allows the caller to
   * short-circuit to `missing-finding` without re-reading the
   * quarantine directory. Optional — when omitted we rely solely
   * on the on-disk `findings/<id>.md` presence check.
   */
  quarantinedFindings?: ReadonlySet<string>;
  /** Test clock. */
  now?: () => Date;
  /** `callTyped` attempt cap. Default 3. */
  maxRetries?: number;
  /** Journal path; swallowed on missing-dir error. */
  journalPath?: string;
  /** Optional tiny adapter — error humanization + provenance summary. */
  tinyAdapter?: TinyAdapter<M>;
  tinyCtx?: TinyCallContext<M>;
  /**
   * Parsed listing of sources in the run's source store. Optional —
   * when omitted we call `research-sources.listRun(runRoot)`.
   * Passing it in lets the driver load the store once and reuse it
   * across all sub-questions.
   */
  sourceIndex?: readonly SourceRef[];
}

// ──────────────────────────────────────────────────────────────────────
// Public entry: runSectionSynth.
// ──────────────────────────────────────────────────────────────────────

/**
 * Drive the synth for a single sub-question. See the module header
 * for flow. Returns the outcome plus, on the happy path, the list
 * of source ids the section actually cited (the caller passes
 * these into merge so renumber only tracks sources that actually
 * appear).
 */
export async function runSectionSynth<M>(opts: SectionSynthOpts<M>): Promise<SectionOutcome> {
  const sq = opts.plan.subQuestions.find((x) => x.id === opts.subQuestionId);
  if (!sq) {
    return {
      kind: 'missing-finding',
      subQuestionId: opts.subQuestionId,
      reason: `sub-question ${opts.subQuestionId} not present in plan`,
    };
  }

  const p = paths(opts.runRoot);
  const sectionsDir = join(p.snapshots, 'sections');
  ensureDirSync(sectionsDir);

  // ── 1. Load the finding. ──────────────────────────────────────
  if (opts.quarantinedFindings?.has(sq.id)) {
    journalIf(opts, 'warn', `synth skipped: finding quarantined`, `sub-question=${sq.id}`);
    return { kind: 'missing-finding', subQuestionId: sq.id, reason: 'finding quarantined upstream' };
  }
  const findingPath = join(p.findings, `${sq.id}.md`);
  if (!existsSync(findingPath)) {
    journalIf(opts, 'warn', `synth skipped: no findings file on disk`, `sub-question=${sq.id}`);
    return { kind: 'missing-finding', subQuestionId: sq.id, reason: `no findings/${sq.id}.md on disk` };
  }
  const findingBody = readFindingBody(findingPath);
  if (findingBody === null) {
    journalIf(opts, 'warn', `synth skipped: finding unreadable`, `sub-question=${sq.id}`);
    return { kind: 'missing-finding', subQuestionId: sq.id, reason: `findings/${sq.id}.md unreadable` };
  }

  // ── 2. Resolve referenced sources. ────────────────────────────
  const sources = collectReferencedSources(opts, findingBody);
  const knownIds = new Set(sources.map((s) => s.id));

  // ── 3. Drive the typed synth turn. ────────────────────────────
  const prompt = renderSectionPrompt(sq, findingBody, sources);
  const schema = makeSectionOutputSchema(knownIds);
  const FALLBACK_SENTINEL: SectionOutput = { markdown: '' };

  const onRetry = buildOnRetry(opts, sq.id);

  const typed = await callTyped<SectionOutput>({
    session: opts.session,
    prompt,
    schema,
    fallback: () => FALLBACK_SENTINEL,
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(onRetry ? { onRetry } : {}),
  });

  // ── 4. Stuck? ────────────────────────────────────────────────
  if (isStuckShape(typed)) {
    journalIf(opts, 'info', `synth emitted stuck`, `sub-question=${sq.id} reason=${typed.reason}`);
    return { kind: 'stuck', subQuestionId: sq.id, reason: typed.reason };
  }

  // ── 5. Fallback path = retries exhausted → quarantine. ────────
  if (typed === FALLBACK_SENTINEL) {
    return quarantineSection({
      opts,
      subQuestionId: sq.id,
      reason: 'section synth retries exhausted',
      bodyAttempt: null,
      sectionsDir,
    });
  }

  // ── 6. Success — normalize, write file + sidecar. ─────────────
  const { markdown, truncated } = normalizeSectionMarkdown(typed.markdown);
  const sectionPath = join(sectionsDir, `${sq.id}.md`);
  const sourceIds = uniquePlaceholderIds(markdown);

  atomicWriteFile(sectionPath, markdown.endsWith('\n') ? markdown : markdown + '\n');

  // Provenance sidecar (optional tiny summary).
  const summary = await tinyProvenanceSummary(opts.tinyAdapter, opts.tinyCtx, renderSummaryExcerpt(sq, prompt));
  const provenance: Provenance = {
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    timestamp: (opts.now ? opts.now() : new Date()).toISOString(),
    promptHash: hashPrompt(prompt),
    ...(summary ? { summary } : {}),
  };
  writeSidecar(sectionPath, provenance);

  if (truncated) {
    journalIf(opts, 'warn', `synth section truncated to cap`, `sub-question=${sq.id} cap=${SECTION_MAX_CHARS}`);
  }
  journalIf(
    opts,
    'step',
    `synth wrote section ${sq.id}`,
    `cited=${sourceIds.length} truncated=${truncated} chars=${markdown.length}`,
  );

  return {
    kind: 'ok',
    subQuestionId: sq.id,
    sectionPath,
    markdown,
    sourceIds,
    truncated,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Public entry: runAllSections.
// ──────────────────────────────────────────────────────────────────────

export interface AllSectionsOpts<M> extends Omit<SectionSynthOpts<M>, 'subQuestionId'> {
  /**
   * Hook called between sub-questions. Lets the driver journal
   * progress / update a statusline widget without threading the
   * callback through every internal call.
   */
  onSection?: (outcome: SectionOutcome) => void;
}

/**
 * Synthesize every sub-question in `plan.subQuestions` order.
 * Failures are isolated — one section's quarantine / stuck never
 * aborts the remaining sub-questions. Returns the full outcome list
 * so the caller (merge stage) can emit visible stubs for missing
 * sections.
 */
export async function runAllSections<M>(opts: AllSectionsOpts<M>): Promise<SectionOutcome[]> {
  // Load the source index once; sub-questions share it.
  const sourceIndex = opts.sourceIndex ?? listRun(opts.runRoot);
  const out: SectionOutcome[] = [];
  for (const sq of opts.plan.subQuestions) {
    // Build the per-section opts by narrowing the shared opts.
    // Forward `sourceIndex` explicitly so we don't listRun() N times.
    const perSection: SectionSynthOpts<M> = {
      runRoot: opts.runRoot,
      plan: opts.plan,
      subQuestionId: sq.id,
      session: opts.session,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      sourceIndex,
      ...(opts.quarantinedFindings ? { quarantinedFindings: opts.quarantinedFindings } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.journalPath ? { journalPath: opts.journalPath } : {}),
      ...(opts.tinyAdapter ? { tinyAdapter: opts.tinyAdapter } : {}),
      ...(opts.tinyCtx ? { tinyCtx: opts.tinyCtx } : {}),
    };
    const outcome = await runSectionSynth(perSection);
    out.push(outcome);
    opts.onSection?.(outcome);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Internals.
// ──────────────────────────────────────────────────────────────────────

function journalIf<M>(
  opts: SectionSynthOpts<M>,
  level: 'info' | 'step' | 'warn' | 'error',
  heading: string,
  body?: string,
): void {
  if (!opts.journalPath) return;
  if (!existsSync(opts.runRoot)) return;
  try {
    appendJournal(opts.journalPath, body !== undefined ? { level, heading, body } : { level, heading });
  } catch {
    /* swallow — journal failures never break the synth */
  }
}

/**
 * Wrap the (optional) tiny error-humanization hook. Mirrors the
 * planner's pattern: run the humanize call best-effort, log to
 * journal, never fail the synth if the tiny call errors.
 */
function buildOnRetry<M>(
  opts: SectionSynthOpts<M>,
  subQuestionId: string,
): ((err: string, n: number) => void) | undefined {
  const adapter = opts.tinyAdapter;
  const ctx = opts.tinyCtx;
  if (!adapter || !ctx || !adapter.isEnabled()) return undefined;
  return (error, attempt) => {
    void adapter
      .callTinyRewrite(ctx, 'humanize-error', error)
      .then((humanized) => {
        if (typeof humanized === 'string' && humanized.trim().length > 0) {
          journalIf(opts, 'info', `synth validation nudge humanized (${subQuestionId} attempt ${attempt})`, humanized);
        }
      })
      .catch(() => {
        /* swallow */
      });
  };
}

/**
 * Read a finding file, returning `null` on any I/O error. The
 * outer caller maps `null` to a `missing-finding` outcome so we
 * never feed an empty prompt to the synth turn (which would
 * either fabricate or stuck).
 */
function readFindingBody(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Truncate `s` to `max` characters, appending an ellipsis marker
 * when the cut actually fires. The marker doubles as a visual cue
 * for the model that the content was trimmed; we don't promise
 * byte-exact preservation.
 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 16)).trimEnd() + '\n\n<!-- truncated -->';
}

/**
 * Parse the `## Sources` section in a finding body via the
 * shared schema helper (`deep-research-finding.extractFindingSourceUrls`)
 * — we never re-implement the regex here; the schema lives in
 * one module.
 */

/**
 * Map a finding's cited URLs to the run's source store, returning
 * `CitationSource` records ready for the prompt + the validator.
 * URL matching goes through `normalizeUrl` so callers that cite
 * with tracking params still land on the cached entry. Unmatched
 * URLs are dropped — a source we don't have cached is not
 * citable at synth time.
 *
 * Secondary path: `findingsPath` on the SubQuestion may point
 * somewhere other than the default; we still read the default
 * location since Phase 2 writes there.
 */
function collectReferencedSources<M>(opts: SectionSynthOpts<M>, findingBody: string): CitationSource[] {
  const index = opts.sourceIndex ?? listRun(opts.runRoot);
  if (index.length === 0) return [];
  const byUrl = new Map<string, SourceRef>();
  for (const ref of index) {
    // `ref.url` is already normalized by `research-sources.persist`.
    byUrl.set(ref.url, ref);
  }
  const urls = extractFindingSourceUrls(findingBody);
  const seen = new Set<string>();
  const out: CitationSource[] = [];
  for (const raw of urls) {
    let normalized: string;
    try {
      normalized = normalizeUrl(raw);
    } catch {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const ref = byUrl.get(normalized);
    if (!ref) continue;
    out.push({ id: ref.id, url: ref.url, title: ref.title });
  }
  return out;
}

/**
 * Enforce {@link SECTION_MAX_CHARS} on the synth's output. Returns
 * the (possibly-truncated) markdown and a flag the caller journals.
 */
function normalizeSectionMarkdown(raw: string): { markdown: string; truncated: boolean } {
  const trimmed = raw.replace(/\s+$/, '');
  if (trimmed.length <= SECTION_MAX_CHARS) {
    return { markdown: trimmed, truncated: false };
  }
  return {
    markdown: trimmed.slice(0, SECTION_MAX_CHARS - 24).trimEnd() + '\n\n<!-- truncated -->',
    truncated: true,
  };
}

/**
 * Extract the unique source ids actually cited by the markdown.
 * Used by the caller (merge) to know which sources to enumerate in
 * the footnotes block when `research-citations.renumber` runs.
 */
function uniquePlaceholderIds(markdown: string): string[] {
  const out = new Set<string>();
  const re = /\{\{SRC:([^}]+)\}\}/g;
  for (const m of markdown.matchAll(re)) {
    const id = m[1];
    if (typeof id === 'string' && id.length > 0) out.add(id);
  }
  return Array.from(out);
}

/**
 * Build the short excerpt handed to `tinyProvenanceSummary` for a
 * section's sidecar. The tiny helper only needs to see what the
 * section is about — a single sub-question id + question + the
 * start of the prompt — not the full finding body.
 */
function renderSummaryExcerpt(sq: SubQuestion, prompt: string): string {
  return `sub-question ${sq.id}: ${sq.question}\n${truncate(prompt, 400)}`;
}

/**
 * Persist a best-effort section attempt and move it under the
 * snapshots/sections/_quarantined/ tree. The returned outcome
 * carries the quarantine target path so a downstream merger can
 * surface "the attempted body is at <path>" if it wants to.
 *
 * When `bodyAttempt` is `null` we write a tiny placeholder marker
 * (`<!-- section unavailable -->`) just so `quarantine()` has
 * something to move — research-quarantine requires the source file
 * to exist.
 */
function quarantineSection<M>(args: {
  opts: SectionSynthOpts<M>;
  subQuestionId: string;
  reason: string;
  bodyAttempt: string | null;
  sectionsDir: string;
}): SectionOutcome {
  const { opts, subQuestionId, reason, bodyAttempt, sectionsDir } = args;
  const markerPath = join(sectionsDir, `${subQuestionId}.md`);
  try {
    const body = bodyAttempt ?? '<!-- section unavailable: retries exhausted -->\n';
    atomicWriteFile(markerPath, body);
  } catch {
    /* swallow — quarantine is best-effort */
  }
  let movedTo: string | undefined;
  try {
    const res = quarantine(markerPath, reason, { caller: 'deep-research-synth-sections' });
    movedTo = res.movedTo;
  } catch (e) {
    journalIf(
      opts,
      'error',
      `synth quarantine move failed ${subQuestionId}`,
      e instanceof Error ? e.message : String(e),
    );
  }
  journalIf(opts, 'warn', `synth quarantined section ${subQuestionId}`, reason);
  return movedTo !== undefined
    ? { kind: 'quarantined', subQuestionId, reason, movedTo }
    : { kind: 'quarantined', subQuestionId, reason };
}
