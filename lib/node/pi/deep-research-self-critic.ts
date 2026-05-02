/**
 * Deep-research self-critic pass.
 *
 * After the cold-start planner emits a plan, the SAME session gets
 * one follow-up turn to review its own work: "look at what you
 * just wrote; if any sub-question is redundant, off-scope, or
 * malformed, rewrite the plan and emit the same schema; otherwise
 * re-emit it verbatim." Cheap, catches obvious first-draft
 * mistakes before the planning-critic subagent spends a real
 * verdict on them.
 *
 * Behavior:
 *
 *   - We drive one `research-structured.callTyped` turn over the
 *     planner's live session. The schema is the same
 *     {@link plannerOutputSchema} used by the planner, so a
 *     rewrite that doesn't pass validation is treated as "keep the
 *     original" — better to ship the original plan than to
 *     dictate a broken rewrite.
 *   - A `Stuck` response here (the model signalling it can't
 *     rewrite) is NOT an escalation — self-critic is advisory. We
 *     keep the original plan and journal the `stuck` reason so
 *     the user can see why the rewrite was skipped.
 *   - When the rewrite IS accepted, we rebuild `plan.json` via
 *     `research-plan.writePlan` (same structural upgrade as the
 *     planner did) and refresh the provenance sidecar. The
 *     pre-rewrite plan is preserved in the journal line ONLY —
 *     there is no separate snapshot file, because the planning-
 *     critic stage produces its own audit trail if the rewrite
 *     turns out wrong.
 *
 * Pure module. No pi imports. The extension wires the live
 * session + tiny adapter through.
 */

import { existsSync } from 'node:fs';

import { promoteToPlan, plannerOutputSchema, type PlannerOutput } from './deep-research-planner.ts';
import { appendJournal } from './research-journal.ts';
import { paths } from './research-paths.ts';
import { type DeepResearchPlan, writePlan } from './research-plan.ts';
import { hashPrompt, type Provenance, writeSidecar } from './research-provenance.ts';
import { callTyped, type ResearchSessionLike } from './research-structured.ts';
import { type Stuck } from './research-stuck.ts';
import { type TinyAdapter, type TinyCallContext } from './research-tiny.ts';
import { isRecord } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Prompt.
// ──────────────────────────────────────────────────────────────────────

/**
 * Render the self-critic prompt. The prompt is deliberately short
 * and imperative — we want the model to scan its own output and
 * correct it, not to narrate the rubric.
 */
export function renderSelfCriticPrompt(plan: DeepResearchPlan): string {
  const lines: string[] = [];
  lines.push('Review the plan you just wrote against these criteria:');
  lines.push('  1. No sub-question is redundant with another.');
  lines.push('  2. Every sub-question stays on-scope for the user question.');
  lines.push('  3. Every sub-question is phrased as a real question, not a topic label.');
  lines.push('  4. searchHints (if any) look plausibly useful for that sub-question.');
  lines.push('  5. ids are unique and of the form "sq-N".');
  lines.push('');
  lines.push('If any criterion is violated, emit a rewritten plan using the SAME JSON schema.');
  lines.push('If everything looks good, re-emit the plan verbatim.');
  lines.push('If you cannot review (vague question, not enough signal), emit {"status":"stuck","reason":"..."}.');
  lines.push('');
  lines.push('For convenience, here is the plan you just emitted:');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        slug: plan.slug,
        question: plan.question,
        subQuestions: plan.subQuestions.map((sq) => ({ id: sq.id, question: sq.question })),
      },
      null,
      2,
    ),
  );
  lines.push('```');
  lines.push('Reply with JSON only. No prose preamble. No markdown fences in the response.');
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Diff detection.
// ──────────────────────────────────────────────────────────────────────

/**
 * True when the rewritten planner output is meaningfully different
 * from the original plan. "Meaningfully" = the set of
 * (id, question) pairs has changed. Other differences (search
 * hints, success criteria order, rubric draft wording) are treated
 * as refinements of the same plan and still trigger a rewrite so
 * the self-critic's ordering decisions survive.
 */
export function rewriteDiffers(before: DeepResearchPlan, after: PlannerOutput): boolean {
  if (after.subQuestions.length !== before.subQuestions.length) return true;
  for (let i = 0; i < after.subQuestions.length; i++) {
    const a = after.subQuestions[i];
    const b = before.subQuestions[i];
    if (a.id !== b.id) return true;
    if (a.question !== b.question) return true;
  }
  // Identical ids+questions in the same order — count search-hint
  // / success-criteria changes as a rewrite worth persisting so
  // the model's triage ordering survives.
  for (const sq of after.subQuestions) {
    if ((sq.searchHints && sq.searchHints.length > 0) || (sq.successCriteria && sq.successCriteria.length > 0)) {
      return true;
    }
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Internals — hoisted above the public entry so `no-use-before-define`
// doesn't complain about forward references.
// ──────────────────────────────────────────────────────────────────────

function isStuckResult(v: unknown): v is Stuck {
  if (!isRecord(v)) return false;
  return v.status === 'stuck' && typeof v.reason === 'string' && v.reason.length > 0;
}

function journalIf<M>(
  opts: SelfCriticOpts<M>,
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

function buildOnRetry<M>(opts: SelfCriticOpts<M>): ((error: string, attempt: number) => void) | undefined {
  const adapter = opts.tinyAdapter;
  const ctx = opts.tinyCtx;

  if (!adapter || !ctx || !adapter.isEnabled()) return undefined;
  return (error, attempt) => {
    void adapter
      .callTinyRewrite(ctx, 'humanize-error', error)
      .then((humanized) => {
        if (typeof humanized === 'string' && humanized.trim().length > 0) {
          journalIf(opts, 'info', `self-critic validation nudge humanized (attempt ${attempt})`, humanized);
        }
      })
      .catch(() => {
        /* swallow */
      });
  };
}

// ──────────────────────────────────────────────────────────────────────
// Public entry point.
// ──────────────────────────────────────────────────────────────────────

export interface SelfCriticOpts<M> {
  /** Run directory root (`<cwd>/research/<slug>/`). */
  runRoot: string;
  /** Current plan just written by the planner. */
  plan: DeepResearchPlan;
  /**
   * Session the planner used — self-critic continues the same
   * conversation so the model can see its own earlier reply.
   */
  session: ResearchSessionLike;
  /** Provenance fields for the potential rewrite. */
  model: string;
  thinkingLevel: string | null;
  /** Test clock. */
  now?: () => Date;
  /** `callTyped` attempt cap. Defaults to 3. */
  maxRetries?: number;
  /** Journal path (optional). */
  journalPath?: string;
  /** Tiny adapter (optional, used only for error humanization). */
  tinyAdapter?: TinyAdapter<M>;
  tinyCtx?: TinyCallContext<M>;
}

export interface SelfCriticResult {
  /** The plan on disk after the self-critic pass ran. */
  plan: DeepResearchPlan;
  /**
   * True when the rewrite was accepted and `plan.json` was
   * overwritten. False when the model re-emitted the same plan,
   * emitted a malformed rewrite, or returned `stuck`.
   */
  rewritten: boolean;
  /** Set when the model returned a stuck shape. Advisory. */
  stuck?: Stuck;
  /**
   * True when `callTyped` exhausted retries. The original plan is
   * kept; this flag lets callers journal a warn.
   */
  exhaustedRetries: boolean;
}

/**
 * Drive the one-turn self-critic pass over the already-live
 * session. Returns the plan currently on disk (rewritten or
 * original) plus diagnostic flags.
 */
export async function runSelfCritic<M>(opts: SelfCriticOpts<M>): Promise<SelfCriticResult> {
  const prompt = renderSelfCriticPrompt(opts.plan);
  const p = paths(opts.runRoot);

  // Sentinel to detect fallback exhaustion (no rewrite, keep original).
  const FALLBACK: PlannerOutput = { subQuestions: [] };

  const typed = await callTyped<PlannerOutput>({
    session: opts.session,
    prompt,
    schema: plannerOutputSchema,
    fallback: () => FALLBACK,
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(buildOnRetry(opts) ? { onRetry: buildOnRetry(opts)! } : {}),
  });

  if (isStuckResult(typed)) {
    journalIf(opts, 'info', 'self-critic stuck (original plan kept)', typed.reason);
    return { plan: opts.plan, rewritten: false, stuck: typed, exhaustedRetries: false };
  }

  if (typed === FALLBACK) {
    journalIf(opts, 'warn', 'self-critic retries exhausted (original plan kept)');
    return { plan: opts.plan, rewritten: false, exhaustedRetries: true };
  }

  if (!rewriteDiffers(opts.plan, typed)) {
    journalIf(opts, 'info', 'self-critic: no changes required');
    return { plan: opts.plan, rewritten: false, exhaustedRetries: false };
  }

  const rewritten = promoteToPlan(typed, opts.plan.question, opts.plan.slug, opts.plan.budget);
  writePlan(p.plan, rewritten);
  const provenance: Provenance = {
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    timestamp: (opts.now ? opts.now() : new Date()).toISOString(),
    promptHash: hashPrompt(prompt),
  };
  writeSidecar(p.plan, provenance);

  const beforeIds = opts.plan.subQuestions.map((sq) => sq.id).join(',');
  const afterIds = rewritten.subQuestions.map((sq) => sq.id).join(',');
  journalIf(opts, 'step', `self-critic rewrote plan`, `before=${beforeIds || '(none)'} after=${afterIds || '(none)'}`);

  return { plan: rewritten, rewritten: true, exhaustedRetries: false };
}
