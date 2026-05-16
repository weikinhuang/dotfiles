/**
 * Deep-research cold-start planner.
 *
 * Given a user question + budget, drive one `research-structured.callTyped`
 * turn in the parent session, validate the reply against the planner-
 * output schema, and materialize:
 *
 *   - `<runRoot>/plan.json` via `research-plan.writePlan`
 *   - `<runRoot>/plan.json.provenance.json` via
 *     `research-provenance.writeSidecar`
 *
 * Deterministic fallback (per plan): if `callTyped` exhausts retries
 * without a valid response, emit a one-sub-question plan where the
 * sole sub-question equals the whole user question. Narrower scope
 * than a rich plan, but still a usable run - per the robustness
 * principle, a silently-fake plan is the failure mode we refuse.
 *
 * Pure module. Takes a `ResearchSessionLike` (already-driven parent
 * session) plus an injected `TinyAdapter`-shaped object; no pi
 * imports. Hand-rolled validators rather than TypeBox, matching the
 * precedent established by `research-plan.ts` and
 * `iteration-loop-schema.ts`. The plan text lists TypeBox as the
 * preferred schema library - revisit once the shared toolkit adopts
 * it, so every `callTyped` caller gets TypeBox together instead of
 * one module drifting out of the hand-rolled convention.
 *
 * Tiny-model integrations (optional, non-load-bearing):
 *
 *   1. **Slug generation.** Fallback: `research-paths.slugify`.
 *      Tiny: `callTinyRewrite(ctx, "slugify", question)`. Called
 *      BEFORE the run dir exists (no `runRoot` on the tiny ctx),
 *      so the per-run call counter is disabled for this one call.
 *      Per the core contract, `null` → fall back silently.
 *   2. **URL type classification.** Each sub-question's
 *      `searchHints` is stable-sorted by a soft priority hint
 *      emitted by `callTinyClassify`. Wrong classification →
 *      suboptimal fetch order, never discards. With the adapter
 *      disabled, hints keep their planner-emitted order (stable).
 *   3. **`callTyped` error humanization.** Validation errors fed
 *      to the retry nudge are rewritten through `callTinyRewrite`
 *      when the adapter is enabled; fallback is the raw error.
 *
 * Caller contract: the session is already set up with whatever
 * system prompt etc the parent wants. This module only sends the
 * planner prompt (and - during retries - the error-humanized nudges
 * via `callTyped`'s internal retry loop). The session's message
 * state is preserved on return so the self-critic can run a second
 * turn over it.
 */

import { existsSync } from 'node:fs';

import { ensureDirSync } from './atomic-write.ts';
import { appendJournal } from './research-journal.ts';
import { paths, runRoot, slugify } from './research-paths.ts';
import { type DeepResearchPlan, type PlanBudget, type SubQuestion, writePlan } from './research-plan.ts';
import { hashPrompt, type Provenance, writeSidecar } from './research-provenance.ts';
import { callTyped, type ResearchSessionLike, type SchemaLike } from './research-structured.ts';
import { type Stuck } from './research-stuck.ts';
import { type TinyAdapter, type TinyCallContext } from './research-tiny.ts';
import { isRecord } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Planner-output schema + validator.
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimum / maximum sub-question count the planner is allowed to
 * emit. Narrower than the v0 draft (4–8) - 3–6 favors depth per
 * question and reduces per-sub-question context pressure. The plan
 * text's Components section is the source of truth.
 */
export const PLANNER_MIN_SUB_QUESTIONS = 3;
export const PLANNER_MAX_SUB_QUESTIONS = 6;

/** One sub-question in the planner-output payload. */
export interface PlannerSubQuestion {
  /** Stable identifier; the planner should use `sq-<n>`. */
  id: string;
  /** The sub-question itself, phrased as a question. */
  question: string;
  /** Optional ordered search hints (URLs or query strings). */
  searchHints?: string[];
  /**
   * Free-form "what would make this sub-question answered" bullets.
   * Feeds the web-researcher prompt as a signal of what "done"
   * looks like.
   */
  successCriteria?: string[];
}

/**
 * Planner's structured output. Narrower than `DeepResearchPlan` -
 * the planner does not set status, findingsPath, or assignedAgent;
 * those are pipeline state the extension manages.
 */
export interface PlannerOutput {
  slug?: string;
  subQuestions: PlannerSubQuestion[];
  /** Free-form success criteria for the overall run. */
  successCriteria?: string[];
  /** Initial rubric draft the user can edit before review. */
  rubricDraft?: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string' && e.length > 0);
}

function validateSubQuestion(
  raw: unknown,
  idx: number,
): { ok: true; value: PlannerSubQuestion } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `subQuestions[${idx}] must be an object` };
  const id = raw.id;
  const q = raw.question;
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { ok: false, error: `subQuestions[${idx}].id must be a non-empty string` };
  }
  if (typeof q !== 'string' || q.trim().length === 0) {
    return { ok: false, error: `subQuestions[${idx}].question must be a non-empty string` };
  }
  const out: PlannerSubQuestion = { id: id.trim(), question: q.trim() };
  if (raw.searchHints !== undefined) {
    if (!isStringArray(raw.searchHints)) {
      return { ok: false, error: `subQuestions[${idx}].searchHints must be a string[]` };
    }
    out.searchHints = raw.searchHints.slice();
  }
  if (raw.successCriteria !== undefined) {
    if (!isStringArray(raw.successCriteria)) {
      return { ok: false, error: `subQuestions[${idx}].successCriteria must be a string[]` };
    }
    out.successCriteria = raw.successCriteria.slice();
  }
  return { ok: true, value: out };
}

/**
 * Validator for the planner's typed output. Used both as the
 * `SchemaLike<PlannerOutput>` inside `callTyped` and as a
 * stand-alone guard on the deterministic fallback path (so a
 * buggy fallback can't ship a malformed plan either).
 */
export const plannerOutputSchema: SchemaLike<PlannerOutput> = {
  validate(v) {
    if (!isRecord(v)) return { ok: false, error: 'root value must be an object' };
    const subs = v.subQuestions;
    if (!Array.isArray(subs)) return { ok: false, error: 'subQuestions must be an array' };
    if (subs.length < PLANNER_MIN_SUB_QUESTIONS) {
      return {
        ok: false,
        error: `subQuestions must have at least ${PLANNER_MIN_SUB_QUESTIONS} entries (got ${subs.length})`,
      };
    }
    if (subs.length > PLANNER_MAX_SUB_QUESTIONS) {
      return {
        ok: false,
        error: `subQuestions must have at most ${PLANNER_MAX_SUB_QUESTIONS} entries (got ${subs.length})`,
      };
    }
    const seenIds = new Set<string>();
    const validated: PlannerSubQuestion[] = [];
    for (let i = 0; i < subs.length; i++) {
      const r = validateSubQuestion(subs[i], i);
      if (!r.ok) return { ok: false, error: r.error };
      if (seenIds.has(r.value.id)) {
        return { ok: false, error: `subQuestions[${i}].id "${r.value.id}" is not unique` };
      }
      seenIds.add(r.value.id);
      validated.push(r.value);
    }
    const out: PlannerOutput = { subQuestions: validated };
    if (typeof v.slug === 'string' && v.slug.trim().length > 0) out.slug = v.slug.trim();
    if (v.successCriteria !== undefined) {
      if (!isStringArray(v.successCriteria)) {
        return { ok: false, error: 'successCriteria must be a string[]' };
      }
      out.successCriteria = v.successCriteria.slice();
    }
    if (v.rubricDraft !== undefined) {
      if (typeof v.rubricDraft !== 'string') {
        return { ok: false, error: 'rubricDraft must be a string' };
      }
      out.rubricDraft = v.rubricDraft;
    }
    return { ok: true, value: out };
  },
};

// ──────────────────────────────────────────────────────────────────────
// Prompt.
// ──────────────────────────────────────────────────────────────────────

/**
 * Render the planner prompt for the parent session. Deliberately
 * small and imperative - the robustness principle says prompt
 * tweaks should help every model, not be forked per-tier.
 *
 * Callers passing a non-default budget get the cap numbers echoed
 * into the prompt so small models who ignore instructions still
 * have a structural reminder of how many sub-questions to emit.
 */
export function renderPlannerPrompt(question: string, budget: PlanBudget): string {
  return [
    `You are the planner for a /research run. User question: ${question}`,
    '',
    `Budget: ${budget.maxSubagents} subagents, ${budget.maxFetches} fetches, $${budget.maxCostUsd} spend, ${budget.wallClockSec}s wall-clock.`,
    '',
    `Emit a JSON object with this shape:`,
    '{',
    `  "slug": "<optional kebab-case slug; omit to let the extension generate one>",`,
    `  "subQuestions": [`,
    `    { "id": "sq-1",`,
    `      "question": "<one focused sub-question>",`,
    `      "searchHints": ["<url-or-query-string>", ...],`,
    `      "successCriteria": ["<what counts as answered>", ...] }`,
    `  ],`,
    `  "successCriteria": ["<run-level bullets>", ...],`,
    `  "rubricDraft": "<initial critic rubric, one bullet per line>"`,
    '}',
    '',
    `Requirements:`,
    `- Emit between ${PLANNER_MIN_SUB_QUESTIONS} and ${PLANNER_MAX_SUB_QUESTIONS} sub-questions.`,
    `- Each sub-question must cover a distinct angle; no redundancy, no near-duplicates.`,
    `- Each id must be unique (use "sq-1", "sq-2", ...).`,
    `- If the user's question is too vague or you cannot produce a real plan, emit {"status":"stuck","reason":"..."} instead. Do not fabricate.`,
    `- Reply with JSON only. No prose preamble. No markdown fences.`,
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Promotion to DeepResearchPlan.
// ──────────────────────────────────────────────────────────────────────

/**
 * Default budget applied when the caller does not specify one.
 * Matches plan.md "default budget" clamp (6 subagents, 40 fetches,
 * $3 spend, 30 min wall-clock) minus the iteration-loop bits that
 * are not planner-scoped.
 */
export const DEFAULT_PLANNER_BUDGET: PlanBudget = {
  maxSubagents: 6,
  maxFetches: 40,
  maxCostUsd: 3,
  wallClockSec: 1800,
};

/** Build the deterministic fallback plan (one sub-question = whole question). */
export function fallbackPlan(question: string, slug: string, budget: PlanBudget): DeepResearchPlan {
  const subQuestions: SubQuestion[] = [
    {
      id: 'sq-1',
      question,
      status: 'pending',
    },
  ];
  return {
    kind: 'deep-research',
    slug,
    question,
    status: 'planning',
    budget,
    subQuestions,
  };
}

/**
 * Promote a validated `PlannerOutput` into a full `DeepResearchPlan`
 * ready for `writePlan`. Extension state (status) is set to
 * `planning`; sub-questions are seeded as `pending` for the fanout
 * scheduler to claim.
 */
export function promoteToPlan(
  output: PlannerOutput,
  question: string,
  slug: string,
  budget: PlanBudget,
): DeepResearchPlan {
  const subQuestions: SubQuestion[] = output.subQuestions.map((sq) => ({
    id: sq.id,
    question: sq.question,
    status: 'pending',
  }));
  return {
    kind: 'deep-research',
    slug,
    question,
    status: 'planning',
    budget,
    subQuestions,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Internals.
// ──────────────────────────────────────────────────────────────────────

// Forward-declared so the public entry point can reference them
// without triggering `no-use-before-define`. Definitions live
// below the public entry point; TypeScript hoists function
// declarations, but lint wants the names visible first.

function isStuckResult(v: unknown): v is Stuck {
  if (!isRecord(v)) return false;
  return v.status === 'stuck' && typeof v.reason === 'string' && v.reason.length > 0;
}

function journalIf<M>(
  opts: PlannerOpts<M>,
  level: 'info' | 'step' | 'warn' | 'error',
  heading: string,
  body?: string,
): void {
  if (!opts.journalPath) return;
  if (!existsSync(opts.cwd)) return;
  try {
    appendJournal(opts.journalPath, body !== undefined ? { level, heading, body } : { level, heading });
  } catch {
    /* swallow - journal failures never break the planner */
  }
}

/** Resolve a slug via tiny adapter (if enabled) or deterministic fallback. */
async function resolveSlug<M>(question: string, opts: PlannerOpts<M>): Promise<string> {
  const fallback = slugify(question);
  if (!opts.tinyAdapter || !opts.tinyCtx || !opts.tinyAdapter.isEnabled()) {
    return fallback;
  }
  try {
    // Slug runs BEFORE the run dir exists: pass a tinyCtx WITHOUT
    // runRoot so the counter is disabled for this one call (the
    // counter file lives under the run root which we haven't
    // created yet).
    const withoutRunRoot: TinyCallContext<M> = { ...opts.tinyCtx };

    delete withoutRunRoot.runRoot;
    delete withoutRunRoot.maxCalls;
    const tinySlug = await opts.tinyAdapter.callTinyRewrite(withoutRunRoot, 'slugify', question);

    if (typeof tinySlug === 'string' && tinySlug.trim().length > 0) {
      // Run the tiny output back through the deterministic slugifier
      // so we guarantee the result meets the on-disk contract even
      // when the tiny model emits punctuation or mixed case.
      const normalized = slugify(tinySlug);

      if (normalized.length > 0) return normalized;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Wrap the caller's `onRetry` so each validation error is optionally
 * rewritten by the tiny adapter before being echoed back through
 * `callTyped`'s nudge. We can't intercept the nudge message itself
 * (it's built inside `callTyped`), but the caller's `onRetry` hook
 * gets the pre-nudge error string, and any message the caller logs
 * (e.g. to the journal) now reads in plain English.
 */
function buildOnRetry<M>(opts: PlannerOpts<M>): ((error: string, attempt: number) => void) | undefined {
  const adapter = opts.tinyAdapter;
  const ctx = opts.tinyCtx;

  if (!adapter || !ctx || !adapter.isEnabled()) {
    // Adapter disabled - raw error flows through unchanged.
    return opts.onRetry;
  }
  return (error, attempt) => {
    // Dispatch the caller's hook with the raw error immediately;
    // the humanization is best-effort and not awaited by
    // `callTyped`.
    opts.onRetry?.(error, attempt);
    void adapter
      .callTinyRewrite(ctx, 'humanize-error', error)
      .then((humanized) => {
        if (typeof humanized === 'string' && humanized.trim().length > 0) {
          opts.onRetry?.(`humanized: ${humanized}`, attempt);
          journalIf(opts, 'info', `planner validation nudge humanized (attempt ${attempt})`, humanized);
        }
      })
      .catch(() => {
        /* swallow - humanization is advisory */
      });
  };
}

/**
 * Apply the tiny URL-type classification to stable-sort each
 * sub-question's `searchHints`. Priority order: content, archive,
 * index, search, other. Classification errors / unknown labels
 * preserve the input order (stable sort on equal keys).
 */
async function applyTinyPriority<M>(output: PlannerOutput, opts: PlannerOpts<M>): Promise<PlannerOutput> {
  const adapter = opts.tinyAdapter;
  const ctx = opts.tinyCtx;

  if (!adapter || !ctx || !adapter.isEnabled()) return output;
  const labels = ['content', 'archive', 'index', 'search', 'other'] as const;
  const priority = (label: string): number => {
    const i = (labels as readonly string[]).indexOf(label);

    return i < 0 ? labels.length : i;
  };

  const subs: PlannerSubQuestion[] = [];

  for (const sq of output.subQuestions) {
    if (!sq.searchHints || sq.searchHints.length < 2) {
      subs.push(sq);
      continue;
    }
    const classified: { hint: string; prio: number; originalIdx: number }[] = [];

    for (let i = 0; i < sq.searchHints.length; i++) {
      const hint = sq.searchHints[i];
      let label: string | null = null;

      try {
        label = await adapter.callTinyClassify(ctx, 'classify-url-type', hint, labels);
      } catch {
        label = null;
      }
      classified.push({ hint, prio: label ? priority(label) : labels.length, originalIdx: i });
    }
    classified.sort((a, b) => (a.prio !== b.prio ? a.prio - b.prio : a.originalIdx - b.originalIdx));
    subs.push({ ...sq, searchHints: classified.map((c) => c.hint) });
  }
  return { ...output, subQuestions: subs };
}

// ──────────────────────────────────────────────────────────────────────
// Public entry point.
// ──────────────────────────────────────────────────────────────────────

export interface PlannerOpts<M> {
  /** The user's free-form research question. */
  question: string;
  /** Workspace cwd (same cwd passed to the extension). */
  cwd: string;
  /** Budget envelope; defaults to {@link DEFAULT_PLANNER_BUDGET}. */
  budget?: PlanBudget;
  /**
   * Already-driven parent session. The planner sends exactly ONE
   * prompt through this session (via `callTyped`); self-critic
   * re-uses the same session afterwards.
   */
  session: ResearchSessionLike;
  /**
   * Caller's model provenance string (e.g. `anthropic/claude-sonnet-4-5`).
   * Recorded on the provenance sidecar. Pass `""` when unknown -
   * the provenance module tolerates an empty-ish value, but
   * callers should surface whatever pi reports for the parent
   * model so post-hoc audits stay honest.
   */
  model: string;
  /**
   * Parent thinking level string ("off" / "low" / "high" / etc.)
   * or `null` when not tracked. Recorded verbatim on the sidecar.
   */
  thinkingLevel: string | null;
  /**
   * Optional tiny adapter. When unset, `isEnabled()` is treated as
   * false and every tiny call-site uses its deterministic
   * fallback. When set, the planner uses it for slug generation,
   * search-hint priority triage, and `callTyped` error
   * humanization.
   */
  tinyAdapter?: TinyAdapter<M>;
  /**
   * Tiny call context. Required when `tinyAdapter` is passed; the
   * extension assembles this from its ExtensionContext.
   */
  tinyCtx?: TinyCallContext<M>;
  /**
   * Per-run tiny-call budget key in `tinyCtx.maxCalls`. The planner
   * consumes AT MOST 3 + subQuestions-count tiny calls - slug
   * (1) + error humanization (≤2 during retries) + one classify per
   * search hint. The call-counter in `tinyCtx.runRoot` enforces the
   * plan-wide 30-call cap.
   */
  /**
   * Clock source for the provenance sidecar. Tests pass a frozen
   * date; production leaves it unset.
   */
  now?: () => Date;
  /**
   * Optional override for `callTyped`'s max attempts. Default
   * matches `callTyped`'s own default (3).
   */
  maxRetries?: number;
  /**
   * Optional `onRetry` pass-through - the extension wires this to
   * journal each validation failure. When set, the planner layers
   * tiny error-humanization ON TOP before calling this hook so the
   * journal and the model both see the friendlier string.
   */
  onRetry?: (error: string, attempt: number) => void;
  /**
   * Optional journal path used to record tiny-adapter failures and
   * planner milestones. When omitted, events are swallowed.
   */
  journalPath?: string;
}

export interface PlannerResult {
  /** The deep-research plan just written to disk. */
  plan: DeepResearchPlan;
  /** Absolute path to the run root (`<cwd>/research/<slug>/`). */
  runRoot: string;
  /**
   * `stuck` → the model declined to plan. Extension treats this as
   * a user-checkpoint (per plan: "planner-stuck escalates to a
   * user checkpoint"). The fallback plan is NOT written in this
   * case; callers decide whether to retry, rewrite, or abort.
   */
  stuck?: Stuck;
  /**
   * True when the deterministic fallback was used (retry budget
   * exhausted without a valid typed response). The journal gets a
   * `warn` entry; callers can decide to surface a notice.
   */
  usedFallback: boolean;
  /** Validated planner output (absent when the fallback fired). */
  plannerOutput?: PlannerOutput;
}

/**
 * Drive the planner turn and materialize `plan.json` + provenance.
 *
 * Flow:
 *   1. Compute `slug` (tiny → fallback slugify).
 *   2. Ensure the run dir exists so `writePlan` can land its file.
 *   3. Call `callTyped` with the planner prompt against `session`.
 *      - Validator: {@link plannerOutputSchema}.
 *      - Fallback: {@link fallbackPlan} promoted to a `PlannerOutput`-
 *        less result (we detect the fallback path and return a
 *        `plan` built with `fallbackPlan` directly).
 *   4. If `callTyped` returned a `Stuck`, propagate it without
 *      writing any plan. The extension decides escalation.
 *   5. Apply the tiny URL-type classification (stable-sort the
 *      search hints by priority). Fallback is no-op.
 *   6. Promote `PlannerOutput` → `DeepResearchPlan`, then
 *      `writePlan` + `writeSidecar`.
 *
 * The returned `session` is the SAME session the caller passed -
 * its message state now includes the planner's prompt + reply so
 * the self-critic can ask for a rewrite in the same context.
 */
export async function runPlanner<M>(opts: PlannerOpts<M>): Promise<PlannerResult> {
  const budget = opts.budget ?? DEFAULT_PLANNER_BUDGET;
  const question = opts.question.trim();
  if (question.length === 0) {
    throw new Error('runPlanner: question must be a non-empty string');
  }

  // 1. Slug.
  const slug = await resolveSlug(question, opts);
  const runRootPath = runRoot(opts.cwd, slug);
  const runPaths = paths(runRootPath);
  ensureDirSync(runRootPath);

  // 2. Callback for onRetry with tiny error humanization.
  const onRetry = buildOnRetry(opts);

  // Sentinel used to detect whether the fallback was exercised.
  const FALLBACK_SENTINEL: PlannerOutput = { subQuestions: [] };

  // 3. Drive the typed turn.
  const typed = await callTyped<PlannerOutput>({
    session: opts.session,
    prompt: renderPlannerPrompt(question, budget),
    schema: plannerOutputSchema,
    fallback: () => FALLBACK_SENTINEL,
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    onRetry,
  });

  // 4. Stuck? Escalate without writing any plan.
  if (isStuckResult(typed)) {
    journalIf(opts, 'warn', 'planner emitted stuck', typed.reason);
    return {
      plan: fallbackPlan(question, slug, budget),
      runRoot: runRootPath,
      stuck: typed,
      usedFallback: false,
    };
  }

  // 5. Fallback path? Build the minimal plan and persist it so the
  // pipeline still runs against a narrowed scope.
  const usedFallback = typed === FALLBACK_SENTINEL;
  let plan: DeepResearchPlan;
  let plannerOutput: PlannerOutput | undefined;
  if (usedFallback) {
    plan = fallbackPlan(question, slug, budget);
    journalIf(
      opts,
      'warn',
      'planner fallback (retries exhausted)',
      `one-sub-question plan written; consider /research --resume after inspecting plan.json`,
    );
  } else {
    const validated: PlannerOutput = typed;
    plannerOutput = await applyTinyPriority(validated, opts);
    plan = promoteToPlan(plannerOutput, question, slug, budget);
  }

  // 6. Persist plan + provenance.
  writePlan(runPaths.plan, plan);
  const provenance: Provenance = {
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    timestamp: (opts.now ? opts.now() : new Date()).toISOString(),
    promptHash: hashPrompt(renderPlannerPrompt(question, budget)),
  };
  writeSidecar(runPaths.plan, provenance);
  journalIf(
    opts,
    'step',
    `planner produced ${plan.subQuestions.length} sub-question${plan.subQuestions.length === 1 ? '' : 's'}`,
  );

  const result: PlannerResult = { plan, runRoot: runRootPath, usedFallback };
  if (plannerOutput) result.plannerOutput = plannerOutput;
  return result;
}
