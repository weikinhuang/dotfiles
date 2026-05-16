/**
 * Deep-research planning-critic dispatch.
 *
 * After planner + self-critic land `plan.json`, the extension
 * hands it to the `research-planning-critic` subagent (shipped by
 * research-core Phase 5) for a neutral pre-flight judgment:
 * "is this plan worth spending fanout budget on?". The critic
 * returns a JSON verdict `{approved, score, issues, summary}` -
 * see `config/pi/agents/research-planning-critic.md` for the
 * agent's output contract and `iteration-loop-check-critic.ts`
 * for the tolerant parser we share here.
 *
 * Dispatch policy (matches Phase 2 handoff prompt):
 *
 *   - Rejected once → emit a rewrite prompt to the same parent
 *     session carrying the critic's issues, validate the rewrite
 *     against the planner schema, persist it, re-run the critic.
 *   - Rejected twice → raise a user checkpoint. We do NOT silently
 *     fanout on a rejected plan; burning subagent budget on a bad
 *     plan is the failure mode the planning-critic gate exists to
 *     prevent.
 *   - Parser / spawn failure → treated as "critic couldn't judge,
 *     keep the plan and warn". We prefer shipping a human-authored
 *     plan past a broken critic to halting the whole pipeline on
 *     infrastructure trouble.
 *
 * Pure module. The subagent spawn is behind an injected
 * `PlanningCriticRunner` - the extension wires this to
 * `runOneShotAgent` + the `research-planning-critic` AgentDef.
 * Tests pass a mock runner that scripts critic responses.
 */

import { existsSync } from 'node:fs';

import { promoteToPlan, plannerOutputSchema, type PlannerOutput } from './deep-research-planner.ts';
import { parseVerdict } from './iteration-loop-check-critic.ts';
import { type Verdict } from './iteration-loop-schema.ts';
import { appendJournal } from './research-journal.ts';
import { paths } from './research-paths.ts';
import { type DeepResearchPlan, writePlan } from './research-plan.ts';
import { hashPrompt, type Provenance, writeSidecar } from './research-provenance.ts';
import { callTyped, type ResearchSessionLike } from './research-structured.ts';
import { type Stuck } from './research-stuck.ts';
import { isRecord } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Runner injection.
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal shim over a one-shot critic subagent invocation. The
 * extension wires this to `runOneShotAgent({agent: 'research-
 * planning-critic', ...})` - tests pass a mock.
 *
 * Contract:
 *   - Input `task` is the full prompt string to hand to the
 *     subagent. `rubric` is passed separately so the runner can
 *     emit the rubric preamble the agent expects.
 *   - Returns the subagent's final assistant text + a stop-reason
 *     classification. An error (infrastructure failure) is
 *     surfaced via `error`; the critic's JSON verdict is always
 *     in `rawText` (parsed by us, not the runner).
 */
export type PlanningCriticRunner = (args: {
  task: string;
  rubric: string;
  signal?: AbortSignal;
}) => Promise<{ rawText: string; error?: string }>;

// ──────────────────────────────────────────────────────────────────────
// Default rubric.
// ──────────────────────────────────────────────────────────────────────

/**
 * Default rubric for the planning-critic. The extension can
 * override (user may commit a different `rubric-planning.md` next
 * to `plan.json`), but this is the shipped baseline.
 *
 * Kept narrow: the critic's job is "worth spending fanout budget
 * on?" - not "perfect plan?". Each line is a single rubric item.
 */
export const DEFAULT_PLANNING_RUBRIC = [
  'Every sub-question covers a distinct angle (no redundancy, no near-duplicates).',
  'Every sub-question stays within the scope of the original question.',
  'Every sub-question is concrete enough that a single web-researcher subagent could answer it.',
  'The number of sub-questions matches the declared budget (3-6 for default runs).',
  'No sub-question is so broad it would exceed a single subagent run.',
  'Sub-question ids are unique and non-empty.',
].join('\n');

// ──────────────────────────────────────────────────────────────────────
// Critic task prompt.
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the task string handed to the subagent. It points the
 * agent at the on-disk plan.json and restates the rubric explicitly
 * so the agent does not have to infer criteria. Mirrors the pattern
 * `iteration-loop-check-critic.buildCriticTask` uses for the main
 * critic.
 */
export function buildPlanningCriticTask(planPath: string, rubric: string): string {
  return [
    'You are dispatched as `research-planning-critic`. Judge the plan at',
    `  ${planPath}`,
    'against this rubric (one bullet per line):',
    '',
    rubric,
    '',
    'Use `read` to open the plan file if needed. Return the JSON verdict shape your agent prompt specifies - `{approved, score, issues, summary}`. Do NOT emit anything outside the JSON object.',
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Auto-rewrite prompt.
// ──────────────────────────────────────────────────────────────────────

/**
 * Render the rewrite prompt fed into the parent session when the
 * critic rejects the plan. Echoes the critic's `issues[]` verbatim
 * so the model sees the same actionable criticism the critic
 * emitted - vague critic nudges produce vague rewrites, which is
 * why the agent's prompt requires specific `issues`.
 *
 * Exported for testing.
 */
export function renderRewritePrompt(plan: DeepResearchPlan, verdict: Verdict): string {
  const issueLines =
    verdict.issues.length === 0
      ? ['(no specific issues listed)']
      : verdict.issues.map((i) => {
          const loc = i.location ? ` @${i.location}` : '';
          return `  - [${i.severity}] ${i.description}${loc}`;
        });
  return [
    'The planning-critic REJECTED the plan you wrote. Summary:',
    `  ${verdict.summary && verdict.summary.length > 0 ? verdict.summary : '(no summary)'}`,
    '',
    'Issues:',
    ...issueLines,
    '',
    'Rewrite the plan to resolve every blocker- and major-severity issue. Emit the planner output schema again - the same JSON shape as before:',
    '{',
    '  "slug": "<optional>",',
    '  "subQuestions": [{"id":"sq-1","question":"...","searchHints":["..."],"successCriteria":["..."]}, ...],',
    '  "successCriteria": ["..."],',
    '  "rubricDraft": "..."',
    '}',
    '',
    'If you cannot rewrite (the user question is too vague or the issues are outside your knowledge), emit {"status":"stuck","reason":"..."} instead. Reply with JSON only. No prose preamble. No markdown fences.',
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Outcome types.
// ──────────────────────────────────────────────────────────────────────

/**
 * Terminal outcome of the planning-critic stage. The extension
 * maps `kind` into its own state machine:
 *
 *   - `approved`: plan is good (possibly after one rewrite); proceed
 *     to fanout. `verdict` is the ACCEPTING verdict. `rewrites` is
 *     the number of auto-rewrites that landed before approval (0 or
 *     1 in the current policy).
 *   - `checkpoint`: critic rejected a plan twice in a row. The
 *     extension must pause and surface the verdict to the user.
 *     `rewrites` is 1 (the auto-rewrite that also got rejected).
 *   - `error`: infrastructure failure reading the critic output. The
 *     extension logs a warn and falls back to "no planning-critic
 *     review" - this matches `structure-wins-over-subjective`: if
 *     the deterministic check (later in the pipeline) rejects, it
 *     overrides any critic silence here.
 *   - `rewrite-stuck`: the rewrite turn emitted `stuck`. Same
 *     escalation shape as `checkpoint` but with a cleaner reason.
 */
export type PlanningCriticOutcome =
  | { kind: 'approved'; verdict: Verdict; rewrites: 0 | 1; plan: DeepResearchPlan }
  | { kind: 'checkpoint'; verdict: Verdict; rewrites: 1; plan: DeepResearchPlan }
  | { kind: 'error'; error: string; plan: DeepResearchPlan }
  | { kind: 'rewrite-stuck'; stuck: Stuck; verdict: Verdict; plan: DeepResearchPlan };

// ──────────────────────────────────────────────────────────────────────
// Internals - hoisted above the public entry so `no-use-before-define`
// doesn't complain about forward references.
// ──────────────────────────────────────────────────────────────────────

type InvokeResult = { kind: 'verdict'; verdict: Verdict } | { kind: 'error'; error: string; plan: DeepResearchPlan };

function isStuckResult(v: unknown): v is Stuck {
  if (!isRecord(v)) return false;
  return v.status === 'stuck' && typeof v.reason === 'string' && v.reason.length > 0;
}

function journalIf(
  opts: PlanningCriticOpts,
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

function summarizeRejection(v: Verdict): string {
  const issueCount = v.issues.length;
  const summary = v.summary && v.summary.length > 0 ? v.summary : '(no summary)';

  return `${summary} - ${issueCount} issue${issueCount === 1 ? '' : 's'}`;
}

async function invokeCritic(
  opts: PlanningCriticOpts,
  task: string,
  rubric: string,
  plan: DeepResearchPlan,
): Promise<InvokeResult> {
  let raw: { rawText: string; error?: string };

  try {
    raw = await opts.runCritic({
      task,
      rubric,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);

    journalIf(opts, 'error', 'planning-critic runner threw', msg);
    return { kind: 'error', error: `planning-critic runner threw: ${msg}`, plan };
  }
  if (raw.error) {
    journalIf(opts, 'warn', 'planning-critic runner returned error', raw.error);
    return { kind: 'error', error: raw.error, plan };
  }
  const parsed = parseVerdict(raw.rawText);

  if (parsed.failed) {
    journalIf(opts, 'warn', 'planning-critic verdict parse failed', raw.rawText.slice(0, 200));
    // `parsed.verdict` still carries a synthetic "failure" verdict -
    // we prefer to treat an unparseable response as an infra error so
    // the extension escalates to user checkpoint rather than
    // silently fanning out.
    return { kind: 'error', error: 'planning-critic verdict unparseable', plan };
  }
  return { kind: 'verdict', verdict: parsed.verdict };
}

// ──────────────────────────────────────────────────────────────────────
// Public entry point.
// ──────────────────────────────────────────────────────────────────────

export interface PlanningCriticOpts {
  /** Run directory root. */
  runRoot: string;
  /** Current plan.json contents (already materialized on disk). */
  plan: DeepResearchPlan;
  /** Critic subagent runner (injected for testing). */
  runCritic: PlanningCriticRunner;
  /**
   * Parent session used for the auto-rewrite turn when the critic
   * rejects. The session carries the planner + self-critic history
   * so the rewrite is informed by the same context.
   */
  session: ResearchSessionLike;
  /** Provenance fields for a potential rewrite. */
  model: string;
  thinkingLevel: string | null;
  /** Rubric text. Defaults to {@link DEFAULT_PLANNING_RUBRIC}. */
  rubric?: string;
  /** Parent turn signal. */
  signal?: AbortSignal;
  /** Test clock. */
  now?: () => Date;
  /** `callTyped` attempt cap on the rewrite turn. Defaults to 3. */
  maxRetries?: number;
  /** Journal path (optional). */
  journalPath?: string;
}

/** Drive the planning-critic dispatch loop (see module header). */
export async function runPlanningCritic(opts: PlanningCriticOpts): Promise<PlanningCriticOutcome> {
  const rubric = opts.rubric ?? DEFAULT_PLANNING_RUBRIC;
  const planPath = paths(opts.runRoot).plan;
  let plan = opts.plan;
  const task = buildPlanningCriticTask(planPath, rubric);

  // ── First judgment ────────────────────────────────────────────────
  const first = await invokeCritic(opts, task, rubric, plan);
  if (first.kind === 'error') return first;
  if (first.verdict.approved) {
    journalIf(opts, 'step', 'planning-critic approved plan', first.verdict.summary);
    return { kind: 'approved', verdict: first.verdict, rewrites: 0, plan };
  }

  // Journal the rejection before we try to rewrite so the audit
  // trail records "what did the critic object to" even if the
  // rewrite crashes.
  journalIf(opts, 'warn', 'planning-critic rejected plan (auto-rewrite will run)', summarizeRejection(first.verdict));

  // ── Auto-rewrite turn ─────────────────────────────────────────────
  const rewritePrompt = renderRewritePrompt(plan, first.verdict);
  const FALLBACK: PlannerOutput = { subQuestions: [] };
  const rewrote = await callTyped<PlannerOutput>({
    session: opts.session,
    prompt: rewritePrompt,
    schema: plannerOutputSchema,
    fallback: () => FALLBACK,
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
  });

  if (isStuckResult(rewrote)) {
    journalIf(opts, 'warn', 'planning-critic rewrite emitted stuck', rewrote.reason);
    return { kind: 'rewrite-stuck', stuck: rewrote, verdict: first.verdict, plan };
  }
  if (rewrote === FALLBACK) {
    journalIf(opts, 'warn', 'planning-critic rewrite retries exhausted (escalating to user checkpoint)');
    return { kind: 'checkpoint', verdict: first.verdict, rewrites: 1, plan };
  }

  // Persist the rewritten plan + fresh provenance.
  const rewritten = promoteToPlan(rewrote, plan.question, plan.slug, plan.budget);
  writePlan(planPath, rewritten);
  const provenance: Provenance = {
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    timestamp: (opts.now ? opts.now() : new Date()).toISOString(),
    promptHash: hashPrompt(rewritePrompt),
  };
  writeSidecar(planPath, provenance);
  plan = rewritten;
  journalIf(opts, 'step', 'planning-critic auto-rewrite landed', `subQuestions=${plan.subQuestions.length}`);

  // ── Second judgment ───────────────────────────────────────────────
  const second = await invokeCritic(opts, task, rubric, plan);
  if (second.kind === 'error') return { kind: 'error', error: second.error, plan };
  if (second.verdict.approved) {
    journalIf(opts, 'step', 'planning-critic approved rewritten plan', second.verdict.summary);
    return { kind: 'approved', verdict: second.verdict, rewrites: 1, plan };
  }

  // Two consecutive rejections → user checkpoint.
  journalIf(
    opts,
    'warn',
    'planning-critic rejected rewritten plan (user checkpoint)',
    summarizeRejection(second.verdict),
  );
  return { kind: 'checkpoint', verdict: second.verdict, rewrites: 1, plan };
}

// ──────────────────────────────────────────────────────────────────────
// Tail - (internals block previously lived here; now hoisted above
// the public entry point.)
// ──────────────────────────────────────────────────────────────────────
