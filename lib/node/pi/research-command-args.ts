/* Read the module comment for the spec; the
 * `no-use-before-define` rule is disabled at the file scope
 * because TS function declarations are hoisted and the reading
 * order is top-down (public API → helpers). */
/* eslint-disable no-use-before-define */

/**
 * Argument parser for the `/research` slash command.
 *
 * The slash-command handler used to split its raw argument string
 * on whitespace and treat the first token as either a mode switch
 * (`--help`, `--list`, `--selftest`) or the first word of the
 * research question. That shape is fine for the original
 * two-mode surface but wedges the moment you want to thread
 * structured overrides (the parent model, per-agent maxTurns,
 * ...): every new flag becomes a special case in the handler,
 * and the tool-callable variant has to re-implement the parsing
 * in TypeBox.
 *
 * This module centralises the parsing in one pure helper so:
 *
 *   - the slash command can hand us its whole `args` string and
 *     get back a tagged union indicating which subcommand /
 *     question + overrides the user meant;
 *   - the tool executor can reuse the same override-validation
 *     helpers so a `model` / `fanoutMaxTurns` string coming off
 *     the LLM tool call is rejected with the same diagnostics
 *     the slash user would see;
 *   - a focused unit-test fixture covers every edge (missing
 *     value, `=`-form, duplicate, unknown flag, trailing /
 *     leading whitespace, mixed-ordering) in one place.
 *
 * Supported flags for the question mode:
 *
 *   `--model provider/id`        parent-model override. inherit-mode
 *                                agents inherit it; agents that pin
 *                                a specific model in their .md stay
 *                                pinned.
 *   `--fanout-max-turns N`       uniform maxTurns override for every
 *                                web-researcher fanout spawn.
 *   `--critic-max-turns N`       uniform maxTurns override for both
 *                                the research-planning-critic and
 *                                the subjective critic spawns.
 *
 * The `=` form (`--flag=value`) is supported alongside the
 * space-separated form (`--flag value`).
 *
 * Subcommands (`--help` / `--list` / `--selftest`) remain first-
 * token-only and do NOT accept overrides (passing one is an
 * error); keeping them narrow avoids confusing shapes like
 * `/research --list --model openai/gpt-5`.
 *
 * No pi imports - the parser is data in / data out.
 */

// -------------------------------------------------------------------
// Parsed shape.
// -------------------------------------------------------------------

/** Overrides bundle - shared by the slash command + the tool. */
export interface ResearchOverrides {
  /**
   * Parent-model override in `provider/id` form. Validated by
   * {@link parseModelSpec}. Replaces the research pipeline's
   * parent-session model (planner / self-crit / synth / merge /
   * refine). Inherit-mode subagents that lack their own
   * per-agent override below fall back to this.
   */
  model?: string;
  /**
   * Per-agent model override for the research-planning-critic
   * subagent. Takes precedence over both `model` and the agent's
   * .md declaration. Undefined → inherit the usual chain.
   */
  planCritModel?: string;
  /**
   * Per-agent model override for the web-researcher fanout
   * workers. Takes precedence over both `model` and the agent's
   * .md declaration.
   */
  fanoutModel?: string;
  /**
   * Per-agent model override for the subjective critic. Takes
   * precedence over both `model` and the agent's .md declaration.
   */
  criticModel?: string;
  /** Max turns for every web-researcher fanout spawn. */
  fanoutMaxTurns?: number;
  /**
   * Max turns for the research-planning-critic + subjective critic
   * spawns.
   */
  criticMaxTurns?: number;
  /**
   * Cap on cross-stage review iterations. Default `4` in the
   * extension's `runReviewPhase`. Raise to give the structural
   * + subjective refinement loop more attempts before a
   * `budget-exhausted` outcome.
   */
  reviewMaxIter?: number;
}

/**
 * Stages at which a `--resume` can re-enter the pipeline. Each
 * corresponds to a function-call boundary inside
 * `runResearchPipeline` — auto-detection in
 * {@link ../research-resume} inspects disk and picks the earliest
 * incomplete stage; a user-supplied `--from=<stage>` overrides it.
 */
export type ResumeStage = 'plan-crit' | 'fanout' | 'synth' | 'review';

const RESUME_STAGES: readonly ResumeStage[] = ['plan-crit', 'fanout', 'synth', 'review'];

/**
 * Resume-only knobs carried alongside the shared {@link
 * ResearchOverrides} bundle. `runRoot` is the directory to
 * resume (absolute or cwd-relative); if omitted the extension
 * picks the most-recent run under `./research/`. `from` pins
 * the resume stage; auto-detected when absent. `reviewMaxIter`
 * bumps the review-loop cap (default 4) so a budget-exhausted
 * prior run can be given more iterations without re-running
 * earlier stages.
 */
export interface ResumeOverrides {
  runRoot?: string;
  from?: ResumeStage;
  /**
   * Sub-question ids to target for a fanout-scoped resume. Non-
   * empty when the user passed `--sq=<id>[,<id>...]`. Callers
   * intersect this with {@link ../research-resume.sumFanoutDeficit}
   * to get the actual re-dispatch set; an id in here that is not
   * present in `plan.json` is surfaced as an error by the
   * extension's resume flow.
   *
   * Only meaningful with `from: 'fanout'` (explicit or the
   * default the extension applies when `--sq` is the sole stage
   * signal). Passing `--sq` with a non-`fanout` `--from` is
   * rejected at the extension layer rather than here so the
   * parser stays a pure validator.
   */
  subQuestionIds?: string[];
}

/**
 * Tagged union returned by {@link parseResearchCommandArgs}. The
 * slash-command handler dispatches on `kind`.
 */
export type ResearchCommandArgs =
  /** `/research` on its own, or `/research --help` / `-h`. */
  | { kind: 'help'; trailing?: string }
  /** `/research --list [ignored-trailing]`. */
  | { kind: 'list'; trailing?: string }
  /** `/research --selftest [ignored-trailing]`. */
  | { kind: 'selftest'; trailing?: string }
  /**
   * `/research --resume [--run-root <path>] [--from <stage>]
   *   [--review-max-iter N] [overrides]` — resume an existing
   * run. `runRoot` defaults to the most-recent `./research/*` if
   * omitted; `from` is auto-detected from on-disk state if
   * omitted.
   */
  | { kind: 'resume'; resume: ResumeOverrides; overrides: ResearchOverrides }
  /**
   * `/research [flags] <question...>` - the parser has already
   * extracted every recognised flag from the token stream, so
   * `question` is just the concatenated remaining tokens.
   */
  | { kind: 'question'; question: string; overrides: ResearchOverrides }
  /** Malformed input that the handler should surface to the user. */
  | { kind: 'error'; error: string };

// -------------------------------------------------------------------
// Helpers exposed for the tool executor (reuse the same validation).
// -------------------------------------------------------------------

/**
 * Validate a model-override string. Accepts `provider/id`; rejects
 * anything without a `/`, with leading/trailing slashes, or with
 * an empty provider / id segment. Returns a normalised
 * `{provider, modelId}` or a human-readable error.
 *
 * `subagent-spawn.ts` has an internal `parseModelSpec` that does
 * the same thing for the `modelOverride` runtime path; this one
 * lives on the pure side so the slash / tool surface can reject
 * bad input before the run even starts.
 */
export function parseModelSpec(spec: string): { provider: string; modelId: string } | { error: string } {
  if (typeof spec !== 'string' || spec.length === 0) {
    return { error: 'model override must be a non-empty "provider/id" string' };
  }
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) {
    return { error: `invalid model override "${spec}" - expected "provider/id"` };
  }
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  if (provider.trim() !== provider || modelId.trim() !== modelId) {
    return {
      error: `invalid model override "${spec}" - provider / id must not have leading or trailing whitespace`,
    };
  }
  return { provider, modelId };
}

/**
 * Validate a `--fanout-max-turns` / `--critic-max-turns` value.
 * Accepts a positive integer string (no decimals, no sign). Caps
 * at 1_000 to catch obvious "I pasted the wrong argument"
 * mistakes without being so tight it surprises anyone.
 */
export function parseMaxTurns(flag: string, raw: string): number | { error: string } {
  if (!/^[0-9]+$/.test(raw)) {
    return { error: `${flag} must be a positive integer, got ${JSON.stringify(raw)}` };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `${flag} must be a positive integer, got ${JSON.stringify(raw)}` };
  }
  if (n > 1000) {
    return { error: `${flag}=${n} is absurd - cap is 1000` };
  }
  return n;
}

// -------------------------------------------------------------------
// Main parser.
// -------------------------------------------------------------------

type KnownFlag =
  | '--model'
  | '--plan-crit-model'
  | '--fanout-model'
  | '--critic-model'
  | '--fanout-max-turns'
  | '--critic-max-turns'
  | '--run-root'
  | '--from'
  | '--sq'
  | '--review-max-iter';
const KNOWN_FLAGS: readonly KnownFlag[] = [
  '--model',
  '--plan-crit-model',
  '--fanout-model',
  '--critic-model',
  '--fanout-max-turns',
  '--critic-max-turns',
  '--run-root',
  '--from',
  '--sq',
  '--review-max-iter',
];

/** Resume-only flags: parser rejects them in `question` mode. */
const RESUME_ONLY_FLAGS: readonly KnownFlag[] = ['--run-root', '--from', '--sq'];

/**
 * Split a raw `/research` argument string into a
 * {@link ResearchCommandArgs}. Trimming + whitespace-splitting
 * happens inside; callers pass their `rawArgs` verbatim.
 */
export function parseResearchCommandArgs(raw: string | undefined): ResearchCommandArgs {
  const trimmed = (raw ?? '').trim();

  if (trimmed === '') return { kind: 'help' };

  const tokens = trimmed.split(/\s+/);
  const first = tokens[0] ?? '';

  if (first === '--help' || first === '-h') {
    const trailing = tokens.slice(1).join(' ').trim();
    return trailing ? { kind: 'help', trailing } : { kind: 'help' };
  }

  if (first === '--list') {
    const trailing = tokens.slice(1).join(' ').trim();
    return trailing ? { kind: 'list', trailing } : { kind: 'list' };
  }

  if (first === '--selftest') {
    const trailing = tokens.slice(1).join(' ').trim();
    return trailing ? { kind: 'selftest', trailing } : { kind: 'selftest' };
  }

  if (first === '--resume') {
    return parseResumeArgs(tokens.slice(1));
  }

  // Question mode. Walk the tokens and peel off known flags. Any
  // `--flag` we don't recognise is an error; leave value tokens
  // alone so a question containing `--` is preserved verbatim
  // once we're past the flag zone.
  const overrides: ResearchOverrides = {};
  const questionTokens: string[] = [];
  let i = 0;
  let seenQuestionToken = false;

  while (i < tokens.length) {
    const token = tokens[i];

    // Once a non-flag token appears, treat the rest as question
    // body verbatim - avoids eating `--` mid-question.
    if (!token.startsWith('--')) {
      seenQuestionToken = true;
      questionTokens.push(token);
      i += 1;
      continue;
    }
    if (seenQuestionToken) {
      questionTokens.push(token);
      i += 1;
      continue;
    }

    // `--flag=value` form.
    const eq = token.indexOf('=');
    let flag: string;
    let value: string | undefined;
    let valueCameFrom: 'inline' | 'next';
    if (eq > 0) {
      flag = token.slice(0, eq);
      value = token.slice(eq + 1);
      valueCameFrom = 'inline';
    } else {
      flag = token;
      value = tokens[i + 1];
      valueCameFrom = 'next';
    }

    if (!isKnownFlag(flag)) {
      return { kind: 'error', error: `unknown flag ${flag} (known: ${KNOWN_FLAGS.join(', ')})` };
    }
    if ((RESUME_ONLY_FLAGS as readonly string[]).includes(flag)) {
      return { kind: 'error', error: `${flag} is only valid with --resume` };
    }

    if (value === undefined || value === '') {
      return { kind: 'error', error: `${flag} requires a value` };
    }

    const applied = applyFlag(flag, value, overrides);
    if (!applied.ok) {
      return { kind: 'error', error: applied.error };
    }

    i += valueCameFrom === 'inline' ? 1 : 2;
  }

  const question = questionTokens.join(' ').trim();
  if (question === '') {
    return { kind: 'error', error: 'no research question provided after flags' };
  }
  return { kind: 'question', question, overrides };
}

function isKnownFlag(flag: string): flag is KnownFlag {
  return (KNOWN_FLAGS as readonly string[]).includes(flag);
}

function applyFlag(
  flag: KnownFlag,
  value: string,
  overrides: ResearchOverrides,
): { ok: true } | { ok: false; error: string } {
  switch (flag) {
    case '--model':
      return applyModelFlag(flag, value, overrides, 'model');
    case '--plan-crit-model':
      return applyModelFlag(flag, value, overrides, 'planCritModel');
    case '--fanout-model':
      return applyModelFlag(flag, value, overrides, 'fanoutModel');
    case '--critic-model':
      return applyModelFlag(flag, value, overrides, 'criticModel');
    case '--fanout-max-turns': {
      if (overrides.fanoutMaxTurns !== undefined) {
        return { ok: false, error: `--fanout-max-turns may only be specified once` };
      }
      const parsed = parseMaxTurns('--fanout-max-turns', value);
      if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
      overrides.fanoutMaxTurns = parsed;
      return { ok: true };
    }
    case '--critic-max-turns': {
      if (overrides.criticMaxTurns !== undefined) {
        return { ok: false, error: `--critic-max-turns may only be specified once` };
      }
      const parsed = parseMaxTurns('--critic-max-turns', value);
      if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
      overrides.criticMaxTurns = parsed;
      return { ok: true };
    }
    case '--review-max-iter': {
      if (overrides.reviewMaxIter !== undefined) {
        return { ok: false, error: `--review-max-iter may only be specified once` };
      }
      const parsed = parseMaxTurns('--review-max-iter', value);
      if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
      overrides.reviewMaxIter = parsed;
      return { ok: true };
    }
    case '--run-root':
    case '--from':
    case '--sq':
      // Resume-only flags are filtered out by the caller
      // (`question` mode rejects them before this switch; the
      // resume-mode parser handles them separately). Hitting
      // them here means the dispatch table drifted.
      return { ok: false, error: `${flag} is not a question-mode flag` };
  }
}

/**
 * Parse the tokens after `--resume` (if any). Each recognised
 * resume-only flag appears at most once; shared override flags
 * (`--model`, `--*-max-turns`, …) reuse the same applier.
 */
function parseResumeArgs(tokens: readonly string[]): ResearchCommandArgs {
  const overrides: ResearchOverrides = {};
  const resume: ResumeOverrides = {};

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.startsWith('--')) {
      return { kind: 'error', error: `--resume takes flags only; unexpected token ${JSON.stringify(token)}` };
    }

    const eq = token.indexOf('=');
    let flag: string;
    let value: string | undefined;
    let valueCameFrom: 'inline' | 'next';
    if (eq > 0) {
      flag = token.slice(0, eq);
      value = token.slice(eq + 1);
      valueCameFrom = 'inline';
    } else {
      flag = token;
      value = tokens[i + 1];
      valueCameFrom = 'next';
    }

    if (!isKnownFlag(flag)) {
      return { kind: 'error', error: `unknown flag ${flag} (known: ${KNOWN_FLAGS.join(', ')})` };
    }
    if (value === undefined || value === '') {
      return { kind: 'error', error: `${flag} requires a value` };
    }

    if (flag === '--run-root') {
      if (resume.runRoot !== undefined) {
        return { kind: 'error', error: `--run-root may only be specified once` };
      }
      resume.runRoot = value;
    } else if (flag === '--from') {
      if (resume.from !== undefined) {
        return { kind: 'error', error: `--from may only be specified once` };
      }
      if (!(RESUME_STAGES as readonly string[]).includes(value)) {
        return {
          kind: 'error',
          error: `--from value ${JSON.stringify(value)} must be one of: ${RESUME_STAGES.join(', ')}`,
        };
      }
      resume.from = value as ResumeStage;
    } else if (flag === '--sq') {
      if (resume.subQuestionIds !== undefined) {
        return { kind: 'error', error: `--sq may only be specified once` };
      }
      // Value is a comma-separated list; trim each token. Reject
      // empty tokens ("--sq=sq-1,,sq-2" or a trailing comma) so
      // the extension never sees ids like `""` that would silently
      // mis-intersect with the plan.
      const ids = value.split(',').map((s) => s.trim());
      if (ids.some((id) => id === '')) {
        return { kind: 'error', error: `--sq value ${JSON.stringify(value)} has an empty id` };
      }
      resume.subQuestionIds = ids;
    } else {
      const applied = applyFlag(flag, value, overrides);
      if (!applied.ok) {
        return { kind: 'error', error: applied.error };
      }
    }

    i += valueCameFrom === 'inline' ? 1 : 2;
  }

  return { kind: 'resume', resume, overrides };
}

/**
 * Keys on {@link ResearchOverrides} that hold a `provider/id`
 * model string. Threaded through {@link applyModelFlag} so each
 * of the four `--*-model` flags reuses one validation +
 * duplicate-check path.
 */
type ModelField = 'model' | 'planCritModel' | 'fanoutModel' | 'criticModel';

function applyModelFlag(
  flag: string,
  value: string,
  overrides: ResearchOverrides,
  field: ModelField,
): { ok: true } | { ok: false; error: string } {
  if (overrides[field] !== undefined) {
    return { ok: false, error: `${flag} may only be specified once` };
  }
  const parsed = parseModelSpec(value);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  overrides[field] = `${parsed.provider}/${parsed.modelId}`;
  return { ok: true };
}

/**
 * Validate an overrides bundle coming from the `research` tool
 * (where the LLM can pass any JSON). Returns a cleaned copy
 * (numbers normalised, model normalised) or a human-readable
 * error. Shares every check with the slash-command parser above.
 */
export function validateToolOverrides(input: {
  model?: unknown;
  planCritModel?: unknown;
  fanoutModel?: unknown;
  criticModel?: unknown;
  fanoutMaxTurns?: unknown;
  criticMaxTurns?: unknown;
  reviewMaxIter?: unknown;
}): { ok: true; overrides: ResearchOverrides; reviewMaxIter?: number } | { ok: false; error: string } {
  const overrides: ResearchOverrides = {};

  const modelFields: readonly ModelField[] = ['model', 'planCritModel', 'fanoutModel', 'criticModel'];
  for (const field of modelFields) {
    const v = input[field];
    if (v === undefined) continue;
    if (typeof v !== 'string') {
      return { ok: false, error: `\`${field}\` must be a "provider/id" string` };
    }
    const parsed = parseModelSpec(v);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    overrides[field] = `${parsed.provider}/${parsed.modelId}`;
  }

  if (input.fanoutMaxTurns !== undefined) {
    const n = coerceNumeric(input.fanoutMaxTurns);
    if (n === null) return { ok: false, error: '`fanoutMaxTurns` must be a positive integer' };
    const parsed = parseMaxTurns('fanoutMaxTurns', String(n));
    if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
    overrides.fanoutMaxTurns = parsed;
  }

  if (input.criticMaxTurns !== undefined) {
    const n = coerceNumeric(input.criticMaxTurns);
    if (n === null) return { ok: false, error: '`criticMaxTurns` must be a positive integer' };
    const parsed = parseMaxTurns('criticMaxTurns', String(n));
    if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
    overrides.criticMaxTurns = parsed;
  }

  let reviewMaxIter: number | undefined;
  if (input.reviewMaxIter !== undefined) {
    const n = coerceNumeric(input.reviewMaxIter);
    if (n === null) return { ok: false, error: '`reviewMaxIter` must be a positive integer' };
    const parsed = parseMaxTurns('reviewMaxIter', String(n));
    if (typeof parsed !== 'number') return { ok: false, error: parsed.error };
    reviewMaxIter = parsed;
    overrides.reviewMaxIter = parsed;
  }

  return reviewMaxIter !== undefined ? { ok: true, overrides, reviewMaxIter } : { ok: true, overrides };
}

function coerceNumeric(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * Render an overrides bundle as a short human-readable suffix for
 * the USAGE / statusline / tool call summary. Returns `''` when
 * nothing is set so callers can unconditionally concatenate.
 */
export function formatOverridesSummary(overrides: ResearchOverrides, resume?: ResumeOverrides): string {
  const parts: string[] = [];
  if (resume?.runRoot) parts.push(`run-root=${resume.runRoot}`);
  if (resume?.from) parts.push(`from=${resume.from}`);
  if (resume?.subQuestionIds && resume.subQuestionIds.length > 0) {
    parts.push(`sq=${resume.subQuestionIds.join(',')}`);
  }
  if (overrides.model) parts.push(`model=${overrides.model}`);
  if (overrides.planCritModel) parts.push(`plan-crit-model=${overrides.planCritModel}`);
  if (overrides.fanoutModel) parts.push(`fanout-model=${overrides.fanoutModel}`);
  if (overrides.criticModel) parts.push(`critic-model=${overrides.criticModel}`);
  if (overrides.fanoutMaxTurns !== undefined) parts.push(`fanout-max-turns=${overrides.fanoutMaxTurns}`);
  if (overrides.criticMaxTurns !== undefined) parts.push(`critic-max-turns=${overrides.criticMaxTurns}`);
  if (overrides.reviewMaxIter !== undefined) parts.push(`review-max-iter=${overrides.reviewMaxIter}`);
  return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
}
