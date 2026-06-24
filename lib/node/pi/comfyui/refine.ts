/**
 * Pure refine engine for the `comfyui` extension's opt-in auto-refine
 * loop. The mirror image of the prompt enhancer ({@link ./enhance.ts}):
 * enhance improves the INPUT (prompt -> protocol) before a render;
 * auto-refine improves the OUTPUT (the pixels) after it.
 *
 * This module is the pure half - the locked critic contract + the
 * engine reducer from the design plan
 * (`plans/comfyui_auto_refine_8b6655aa.plan.md`, "Critic contract +
 * engine reducer (locked)"). It holds NO pi imports and NO network /
 * subagent calls: the vision critic and the renderer are INJECTED into
 * {@link runRefineLoop} so the reducer is unit-testable with mocks,
 * exactly like `enhance.spec.ts`.
 *
 * The three responsibilities here:
 *
 * 1. {@link parseCriticDecision} - forgiving parse of a local vision
 *    model's text into a {@link CriticDecision} (strip fences, extract
 *    the first JSON object, tolerate missing / extra fields), or `null`
 *    when no usable object can be recovered.
 * 2. {@link validateAction} / {@link fallbackFor} - the class-aware
 *    downgrade. The critic proposes an action; the engine validates it
 *    against the configured companion channels and, when it is not
 *    runnable, derives a fallback from the defect classes (the
 *    defect -> channel table), never wedging on a weak model's
 *    impossible proposal. `reroll` and `revise_prompt` are pure
 *    text-to-image and therefore ALWAYS available.
 * 3. {@link runRefineLoop} - the pure reducer: critique, stop on accept
 *    (verdict) or on score >= threshold, validate + downgrade the
 *    action, re-render, track best-so-far (verdict-driven, score as a
 *    coarse tiebreak), and stop on the iteration cap, a plateau, or an
 *    unparseable decision.
 */

import { parseJsonLoose, stripCodeFence } from '../json-loose.ts';
import { parseModelSpec } from '../model-spec.ts';
import { isFiniteNumber, isNonEmptyString, isRecord } from '../shared.ts';
import { type AgentDef } from '../subagent/loader.ts';
import { type ModelRegistryLike, resolveChildModel } from '../subagent/spawn.ts';

// ──────────────────────────────────────────────────────────────────────
// The locked critic contract
// ──────────────────────────────────────────────────────────────────────

/** Whether the critic considers the image good enough as-is. */
export type RefineVerdict = 'accept' | 'revise';

/**
 * How localized a defect is, which drives the fallback channel:
 * `local` (a fixable region), `global` (whole-image / prompt), or
 * `structural` (topology errors a box cannot fix - reroll / revise
 * only, never inpaint).
 */
export type RefineScope = 'local' | 'global' | 'structural';

/**
 * A repair channel. `reroll` and `revise_prompt` are pure
 * text-to-image and always available; the rest require a configured
 * companion workflow for the source workflow.
 */
export type RefineChannel = 'reroll' | 'revise_prompt' | 'img2img' | 'inpaint' | 'detailer' | 'ground';

/** Repair channels that need no companion workflow - always runnable. */
const ALWAYS_AVAILABLE: ReadonlySet<RefineChannel> = new Set(['reroll', 'revise_prompt']);

const ALL_CHANNELS: readonly RefineChannel[] = ['reroll', 'revise_prompt', 'img2img', 'inpaint', 'detailer', 'ground'];

/** One classified defect the critic spotted (drives the fallback). */
export interface RefineIssue {
  /** Free-form defect class, e.g. `bad_hands`, `prompt_miss`. */
  kind: string;
  /** Localization class - see {@link RefineScope}. */
  scope: RefineScope;
  /** Optional human note ("6 fingers", "no rain"). */
  detail?: string;
}

/**
 * The single highest-impact fix the critic proposes. Fields beyond
 * `type` are channel-specific and advisory - the engine only routes on
 * `type`; the injected renderer consumes the rest.
 */
export interface RefineAction {
  type: RefineChannel;
  /** revise_prompt: replacement positive. */
  prompt?: string;
  /** revise_prompt: augmented negative. */
  negative?: string;
  /** revise_prompt: reroll the seed alongside the prompt change. */
  newSeed?: boolean;
  /** img2img / inpaint: denoise strength. */
  denoise?: number;
  /** img2img / inpaint: free-form instruction. */
  instruction?: string;
  /** detailer: detector target (`hand` | `face` | `eyes` | `person`). */
  detect?: string;
  /** ground: target phrase for the grounder ("the left pauldron"). */
  target?: string;
  /** inpaint: coarse region hint ("center"). */
  region?: string;
}

/** The exactly-one JSON object the critic returns. */
export interface CriticDecision {
  verdict: RefineVerdict;
  /** 0-10 vs the criteria; coarse, a tiebreak only. */
  score: number;
  assessment: string;
  /** All problems, each classified - drives the fallback. */
  issues: RefineIssue[];
  /** Single highest-impact fix; omitted / ignored on `accept`. */
  action?: RefineAction;
}

// ──────────────────────────────────────────────────────────────────────
// Forgiving parse (mirrors enhance.ts' tolerant JSON recovery)
// ──────────────────────────────────────────────────────────────────────

/** Clamp a raw score onto the 0-10 scale; non-finite -> 0. */
function clampScore(raw: unknown): number {
  if (!isFiniteNumber(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 10) return 10;
  return raw;
}

function isRefineChannel(v: unknown): v is RefineChannel {
  return typeof v === 'string' && (ALL_CHANNELS as readonly string[]).includes(v);
}

function parseScope(v: unknown): RefineScope {
  return v === 'local' || v === 'global' || v === 'structural' ? v : 'local';
}

/** Parse the `issues` array, dropping entries without a usable `kind`. */
function parseIssues(raw: unknown): RefineIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: RefineIssue[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (!isNonEmptyString(item.kind)) continue;
    const kind = item.kind.trim();
    if (kind.length === 0) continue;
    const issue: RefineIssue = { kind, scope: parseScope(item.scope) };
    if (isNonEmptyString(item.detail)) issue.detail = item.detail.trim();
    out.push(issue);
  }
  return out;
}

/**
 * Parse the proposed action. Returns a {@link RefineAction} only when a
 * recognized `type` is present; otherwise `undefined` (an action the
 * engine cannot route is no action at all).
 */
function parseAction(raw: unknown): RefineAction | undefined {
  if (!isRecord(raw)) return undefined;
  if (!isRefineChannel(raw.type)) return undefined;
  const action: RefineAction = { type: raw.type };
  if (isNonEmptyString(raw.prompt)) action.prompt = raw.prompt;
  if (isNonEmptyString(raw.negative)) action.negative = raw.negative;
  if (typeof raw.newSeed === 'boolean') action.newSeed = raw.newSeed;
  if (isFiniteNumber(raw.denoise)) action.denoise = raw.denoise;
  if (isNonEmptyString(raw.instruction)) action.instruction = raw.instruction;
  if (isNonEmptyString(raw.detect)) action.detect = raw.detect;
  if (isNonEmptyString(raw.target)) action.target = raw.target;
  if (isNonEmptyString(raw.region)) action.region = raw.region;
  return action;
}

/**
 * Tolerantly parse the critic's final text into a {@link CriticDecision},
 * or `null` when no usable JSON object can be recovered. Never throws.
 *
 * Accepts clean JSON, a fenced block (tagged or not), and JSON embedded
 * in surrounding prose. Missing / extra fields are tolerated and filled
 * with safe defaults (`verdict: 'revise'`, `score: 0`, `assessment: ''`,
 * `issues: []`, no `action`) so a sparse-but-present object still yields
 * a decision; only the total absence of an object returns `null`.
 */
export function parseCriticDecision(raw: string): CriticDecision | null {
  const unfenced = stripCodeFence(raw);
  if (unfenced.length === 0) return null;

  const parsed = parseJsonLoose(unfenced);
  if (!isRecord(parsed)) return null;

  const decision: CriticDecision = {
    verdict: parsed.verdict === 'accept' ? 'accept' : 'revise',
    score: clampScore(parsed.score),
    assessment: isNonEmptyString(parsed.assessment) ? parsed.assessment.trim() : '',
    issues: parseIssues(parsed.issues),
  };

  const action = parseAction(parsed.action);
  if (action !== undefined) decision.action = action;

  return decision;
}

// ──────────────────────────────────────────────────────────────────────
// Validate + class-aware downgrade
// ──────────────────────────────────────────────────────────────────────

/** A channel is offered when always-available or among the configured set. */
function channelAvailable(channel: RefineChannel, available: readonly RefineChannel[]): boolean {
  return ALWAYS_AVAILABLE.has(channel) || available.includes(channel);
}

/**
 * Return the critic's proposed `action` when its channel is runnable for
 * this source workflow, else `null`. `reroll` / `revise_prompt` are
 * always runnable; the companion channels (img2img / inpaint / detailer /
 * ground) are runnable only when configured in `availableChannels`.
 */
export function validateAction(
  action: RefineAction | undefined,
  availableChannels: readonly RefineChannel[],
): RefineAction | null {
  if (action === undefined) return null;
  if (!isRefineChannel(action.type)) return null;
  return channelAvailable(action.type, availableChannels) ? action : null;
}

/**
 * The defect-class -> repair-channel preference chain (most specific
 * first). Class-aware, NOT a fixed linear fallback: `bad_hands` with no
 * detailer prefers a `reroll` (a new seed often fixes hands) over a
 * whole-image `img2img`, and a `structural` defect never routes to
 * inpaint (a box cannot fix a topology error).
 */
function channelChainForIssue(issue: RefineIssue): RefineChannel[] {
  const kind = issue.kind.toLowerCase();
  // Topology / whole-outfit errors: regen only, never localized.
  if (issue.scope === 'structural') return ['reroll', 'revise_prompt'];
  // Prompt adherence: rewrite the prompt.
  if (kind.includes('prompt') || kind.includes('content')) return ['revise_prompt'];
  // Hands / face / eyes: detector-driven detailer, else a fresh seed.
  if (/hand|face|eye/.test(kind)) return ['detailer', 'reroll'];
  // Anatomy glitch on an otherwise good prompt: regen.
  if (kind.includes('anatomy')) return ['reroll', 'revise_prompt'];
  // A named wrong object / accessory: grounded inpaint, then coarser.
  if (kind.includes('object') || kind.includes('accessory') || kind.includes('artifact')) {
    return ['ground', 'inpaint', 'img2img', 'reroll'];
  }
  // Generic local polish, low localization confidence: whole-image.
  if (issue.scope === 'local') return ['img2img', 'reroll'];
  // Anything else (global, unclassified): a fresh seed is the safe bet.
  return ['reroll', 'revise_prompt'];
}

/**
 * Derive a runnable fallback action from the classified `issues` when the
 * critic's proposed action is missing / not runnable. Walks the issues in
 * order, takes each one's class-aware channel chain (intersected with the
 * available channels), and returns the first runnable channel as a bare
 * `{ type }` action. Returns `null` only when there is nothing to route
 * (no issues, or no issue maps to a runnable channel).
 */
export function fallbackFor(
  issues: readonly RefineIssue[],
  availableChannels: readonly RefineChannel[],
): RefineAction | null {
  for (const issue of issues) {
    for (const channel of channelChainForIssue(issue)) {
      if (channelAvailable(channel, availableChannels)) return { type: channel };
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// The locked engine reducer
// ──────────────────────────────────────────────────────────────────────

/** One render in the refine journey: what produced it + how it scored. */
export interface RefineJourneyEntry {
  /** The action that produced this image (`'initial'` for render #0). */
  action: string;
  /** The critic's 0-10 score for this image (0 when unparseable). */
  score: number;
  /** Where the image was written, when the caller tracks paths. */
  savedPath?: string;
}

export interface RefineLoopResult<Img> {
  /** The best-so-far image (verdict-driven, score as a coarse tiebreak). */
  image: Img;
  /** Whether the returned image cleared the accept bar. */
  accepted: boolean;
  /** The returned image's critic score. */
  finalScore: number;
  /** Every render performed, oldest first (index 0 is the initial). */
  journey: RefineJourneyEntry[];
}

/**
 * Everything the reducer needs. `critique` (the vision subagent) and
 * `render` (the network submit) are INJECTED so the loop stays pure and
 * unit-testable; both may be sync or async.
 */
export interface RefineLoopDeps<Img> {
  /** The already-rendered render #0. */
  initialImage: Img;
  /** Judge an image; returns the decision, or `null` when unparseable. */
  critique: (image: Img) => CriticDecision | null | Promise<CriticDecision | null>;
  /** Produce a new image from a corrective action. */
  render: (action: RefineAction) => Img | Promise<Img>;
  /** Companion channels configured for the source workflow. */
  availableChannels: readonly RefineChannel[];
  /**
   * Corrective renders allowed AFTER the initial (total renders <=
   * 1 + maxRefineIterations). 0 means "critique the initial only".
   */
  maxRefineIterations: number;
  /** Force-accept when a score reaches this, independent of the verdict. */
  refineAcceptThreshold: number;
  /** Optional saved-path extractor for journey bookkeeping. */
  savedPathOf?: (image: Img) => string | undefined;
}

interface Candidate<Img> {
  image: Img;
  score: number;
  accepted: boolean;
  decision: CriticDecision | null;
}

/** An image clears the bar on an `accept` verdict OR a score >= threshold. */
function clearsBar(decision: CriticDecision | null, threshold: number): boolean {
  if (decision === null) return false;
  return decision.verdict === 'accept' || decision.score >= threshold;
}

/**
 * Best-so-far selection: verdict-driven, score as a coarse tiebreak. An
 * accepted candidate always beats a non-accepted one; within the same
 * class a strictly higher score wins, otherwise the incumbent stays.
 */
function preferred<Img>(incumbent: Candidate<Img>, challenger: Candidate<Img>): Candidate<Img> {
  if (incumbent.accepted !== challenger.accepted) return challenger.accepted ? challenger : incumbent;
  return challenger.score > incumbent.score ? challenger : incumbent;
}

/**
 * Run the locked refine reducer. Critiques the initial image, then loops
 * corrective renders until the image is accepted (verdict or score >=
 * `refineAcceptThreshold`), the decision is unparseable, no runnable
 * action remains, the score plateaus, or the iteration cap is hit -
 * always returning the best-so-far (never an error).
 */
export async function runRefineLoop<Img>(deps: RefineLoopDeps<Img>): Promise<RefineLoopResult<Img>> {
  const { initialImage, critique, render, availableChannels, maxRefineIterations, refineAcceptThreshold } = deps;

  const savedPath = (image: Img): string | undefined => deps.savedPathOf?.(image);
  const journey: RefineJourneyEntry[] = [];

  const evaluate = (image: Img, action: string, decision: CriticDecision | null): Candidate<Img> => {
    const score = decision === null ? 0 : decision.score;
    const path = savedPath(image);
    journey.push({ action, score, ...(path !== undefined ? { savedPath: path } : {}) });
    return { image, score, accepted: clearsBar(decision, refineAcceptThreshold), decision };
  };

  let current = evaluate(initialImage, 'initial', await critique(initialImage));
  let best = current;

  for (let renders = 0; renders < maxRefineIterations; renders++) {
    const decision = current.decision;
    // Unparseable critic output -> never burn budget on noise.
    if (decision === null) break;
    // Accept (verdict or score backstop) -> stop; best already covers current.
    if (current.accepted) break;

    const action =
      validateAction(decision.action, availableChannels) ?? fallbackFor(decision.issues, availableChannels);
    // Nothing runnable -> stop with the best-so-far.
    if (action === null) break;

    const previousScore = current.score;
    // oxlint-disable-next-line no-await-in-loop -- each round renders from the prior round's action, so the loop is inherently sequential
    const rendered = await render(action);
    // oxlint-disable-next-line no-await-in-loop -- the critic must judge this render before the next action can be chosen
    const nextDecision = await critique(rendered);
    current = evaluate(rendered, action.type, nextDecision);
    best = preferred(best, current);

    // Plateau-exit: a corrective render that did not improve the score
    // (and did not clear the bar) means more rounds are unlikely to help.
    if (!current.accepted && current.score <= previousScore) break;
  }

  return { image: best.image, accepted: best.accepted, finalScore: best.score, journey };
}

// ──────────────────────────────────────────────────────────────────────
// Journey block + summary note (the OUTPUT side of the loop)
// ──────────────────────────────────────────────────────────────────────

/**
 * The compact refine-journey block recorded on the final generation (and
 * shown in `/comfyui gallery <id>` detail). `rounds` is the number of
 * corrective renders after the initial (so `journey.length - 1`); `journey`
 * keeps every render oldest-first, the index-0 entry being the initial.
 */
export interface RefineJourney {
  rounds: number;
  accepted: boolean;
  finalScore: number;
  journey: RefineJourneyEntry[];
}

/** Project a {@link RefineLoopResult} into the persisted {@link RefineJourney}. */
export function toRefineJourney(result: RefineLoopResult<unknown>): RefineJourney {
  return {
    rounds: Math.max(0, result.journey.length - 1),
    accepted: result.accepted,
    finalScore: result.finalScore,
    journey: result.journey,
  };
}

/**
 * One-line note appended to the model-facing summary describing the refine
 * journey, e.g. `auto-refined 2 rounds: reroll \u2192 revise_prompt; accepted,
 * score 8`, or - when the budget ran out without an accept -
 * `auto-refined 2 rounds: reroll \u2192 reroll; best effort, score 6 - not
 * fully satisfied`. When no corrective render ran, reports whether the initial
 * was accepted as-is. Returned without surrounding parentheses so the caller
 * composes the final placement. Never throws.
 */
export function summarizeRefineJourney(result: RefineLoopResult<unknown>): string {
  const corrective = result.journey.slice(1).map((j) => j.action);
  const rounds = corrective.length;
  if (rounds === 0) {
    return result.accepted
      ? `auto-refine: accepted as-is, score ${result.finalScore}`
      : `auto-refine: kept initial render, score ${result.finalScore}`;
  }
  const chain = corrective.join(' \u2192 ');
  const roundsWord = `${rounds} round${rounds === 1 ? '' : 's'}`;
  return result.accepted
    ? `auto-refined ${roundsWord}: ${chain}; accepted, score ${result.finalScore}`
    : `auto-refined ${roundsWord}: ${chain}; best effort, score ${result.finalScore} - not fully satisfied`;
}

// ─────────────────────────────────────────────────────────
// Critic task builder (the input side - mirrors enhance.ts' buildEnhanceTask)
// ─────────────────────────────────────────────────────────

/** What the render was asked to depict - the critic judges against this. */
export interface CritiqueRequest {
  /** The positive prompt the image was rendered from. */
  prompt: string;
  /** Negative prompt, for context on what should be absent. Optional. */
  negative?: string;
  /**
   * Per-call background to honor but not necessarily depict literally
   * (scene / continuity facts). Distinct from the literal `prompt`.
   */
  context?: string;
  /**
   * Target prompting protocol (e.g. "Danbooru tags, comma-separated"), so a
   * proposed `revise_prompt` stays in this model's dialect. Optional.
   */
  promptProtocol?: string;
  /**
   * Concatenated critic guidance (global-first, then per-workflow) telling
   * the critic what "good" means for this image model. Optional.
   */
  guidance?: string;
}

export interface CritiqueTaskOpts {
  /** Filesystem path to the saved PNG for this render; the critic reads it. */
  imagePath: string;
  /** What the render was asked to depict. */
  request: CritiqueRequest;
  /**
   * Repair channels runnable for this source workflow (the available-action
   * hint). `reroll` / `revise_prompt` are always present; companion channels
   * appear only when configured. The engine still validates + downgrades, so
   * this is advice to the critic, not a contract.
   */
  availableActions: readonly RefineChannel[];
  /**
   * Optional explicit acceptance criteria ("full body, facing left"). Absent
   * -> the critic derives criteria from the prompt + context.
   */
  criteria?: string;
}

/**
 * Build the task prompt for the `comfyui-critic` agent: point it at the
 * saved PNG, hand it the request (prompt / negative / protocol / context),
 * any guidance, the explicit criteria, and the available-action hint, then
 * ask for the locked decision JSON back. Domain-neutral - it judges against
 * the request, not against any particular feature's notion of "good".
 */
export function buildCritiqueTask(opts: CritiqueTaskOpts): string {
  const parts: string[] = [];

  parts.push(`Read and inspect the rendered image at this path, then judge it:\n${opts.imagePath.trim()}`);

  const guidance = opts.request.guidance?.trim();
  if (guidance !== undefined && guidance.length > 0) {
    parts.push(
      'Guidance on what counts as good for this image model (authoritative - follow it, and let it override any ' +
        `default):\n${guidance}`,
    );
  }

  parts.push(`The image was rendered from this prompt:\n${opts.request.prompt.trim()}`);

  const negative = opts.request.negative?.trim();
  if (negative !== undefined && negative.length > 0) {
    parts.push(`Negative prompt (these should be ABSENT from the image):\n${negative}`);
  }

  const protocol = opts.request.promptProtocol?.trim();
  if (protocol !== undefined && protocol.length > 0) {
    parts.push(`If you propose a revise_prompt action, write its prompt / negative in this protocol: ${protocol}`);
  }

  const context = opts.request.context?.trim();
  if (context !== undefined && context.length > 0) {
    parts.push(
      'Background the render was meant to honor (used to disambiguate / keep continuity; not necessarily depicted ' +
        `literally):\n${context}`,
    );
  }

  const criteria = opts.criteria?.trim();
  if (criteria !== undefined && criteria.length > 0) {
    parts.push(`Explicit acceptance criteria (these must be met to accept):\n${criteria}`);
  } else {
    parts.push('No explicit acceptance criteria were given - derive them from the prompt and any background above.');
  }

  const actions = opts.availableActions.filter((a) => a.length > 0);
  parts.push(
    actions.length > 0
      ? `Repair channels available for this workflow (prefer one of these as your action.type): ${actions.join(', ')}.`
      : 'Only the prompt-level channels (reroll, revise_prompt) are available for this workflow; propose one of those ' +
          'when you revise.',
  );

  parts.push(
    'Return ONLY the decision JSON object described in your instructions (verdict, score, assessment, issues, and an ' +
      'action when you revise). Output nothing but the JSON object - no prose, no preamble, no code fence.',
  );

  return parts.join('\n\n');
}

// ─────────────────────────────────────────────────────────
// Model resolution (mirrors enhance.ts' resolveEnhanceModel)
// ─────────────────────────────────────────────────────────

export interface RefineSettings {
  /** Resolved model spec of the form `provider/model-id`. */
  refineModel: string;
}

/**
 * Validate a configured `refineModel` spec into a `provider/model-id`
 * string, or `null` when absent / malformed. A `null` result means the
 * critic inherits the parent session model (it is NOT disabled), exactly
 * like {@link resolveEnhanceModel}. The vision-capability gate is applied
 * later, against the resolved runtime model, by {@link createRefiner}'s
 * injected `isVisionModel`.
 */
export function resolveRefineModel(raw: string | undefined): RefineSettings | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseModelSpec(raw);
  if (!parsed) return null;
  return { refineModel: `${parsed.provider}/${parsed.modelId}` };
}

// ─────────────────────────────────────────────────────────
// Adapter factory (mirrors enhance.ts' createEnhancer)
// ─────────────────────────────────────────────────────────

/** Result of a one-shot critic run, as returned by `runOneShotAgent`. */
export interface CritiqueRunResult {
  finalText: string;
  /** One of `completed | max_turns | aborted | error`. */
  stopReason: string;
  errorMessage?: string;
}

/**
 * Diagnostic verbosity levels. `debug` is the success / fired-OK channel
 * (gated behind a debug env at the call site); `info` / `warn` are
 * always-surfaced problems the user should see.
 */
export type RefineLogLevel = 'debug' | 'info' | 'warn';

/**
 * Shim over `runOneShotAgent` - tests replace this with a mock returning
 * scripted {@link CritiqueRunResult} values without spawning anything.
 */
export type RefineRunOneShot<M> = (args: {
  cwd: string;
  agent: AgentDef;
  model: M;
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  task: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<CritiqueRunResult>;

/** Structural parent-context the adapter needs to spawn a child. */
export interface RefineContext<M> {
  cwd: string;
  /** Parent's current model - inherited when settings don't override. */
  model: M | undefined;
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  /** Parent signal. */
  signal?: AbortSignal;
}

/** Per-call critique input bundled for {@link Refiner.critique}. */
export interface CritiqueInput {
  /** Filesystem path to the saved PNG the critic should read. */
  imagePath: string;
  /** What the render was asked to depict. */
  request: CritiqueRequest;
  /** Repair channels runnable for this source workflow (the action hint). */
  availableActions: readonly RefineChannel[];
  /** Optional explicit acceptance criteria. */
  criteria?: string;
}

/** Everything the adapter needs from the pi runtime + environment. */
export interface RefinerWiring<M> {
  /** Resolved model override. `null` -> inherit the parent model (NOT disabled). */
  settings: RefineSettings | null;
  /** Loaded `comfyui-critic` agent. `null` -> refiner disabled (agent not installed). */
  criticAgent: AgentDef | null;
  /** One-shot spawner. Usually `runOneShotAgent` wrapped. */
  runOneShot: RefineRunOneShot<M>;
  /**
   * Vision-capability predicate for the resolved runtime model. The critic
   * MUST `read` a PNG, so a non-vision model is a no-op. Injected because
   * the capability flag lives on the pi `Model` type, which this pure module
   * does not import; the `ext/comfyui/refiner.ts` wiring supplies
   * `(m) => m.input.includes('image')`.
   */
  isVisionModel: (model: M) => boolean;
  /** Optional diagnostic sink - non-fatal errors are reported here. */
  log?: (level: RefineLogLevel, message: string) => void;
  /** Per-call agent timeout, in ms. Default 120000. */
  timeoutMs?: number;
}

export interface Refiner<M = unknown> {
  isEnabled(): boolean;
  /**
   * Critique one rendered image. Returns the {@link CriticDecision}, or
   * `null` on ANY failure (disabled, model-resolution failure, no vision
   * model, spawn error, non-`completed` stop, unparseable output) so the
   * loop degrades gracefully and never errors a render.
   */
  critique(ctx: RefineContext<M>, input: CritiqueInput): Promise<CriticDecision | null>;
}

const DEFAULT_REFINE_TIMEOUT_MS = 120000;

function report(
  wiring: { log?: (level: RefineLogLevel, message: string) => void },
  level: RefineLogLevel,
  message: string,
): void {
  if (!wiring.log) return;
  try {
    wiring.log(level, message);
  } catch {
    /* swallow - diagnostics never break the adapter */
  }
}

/**
 * Turn a non-`completed` run into an actionable diagnostic. `spawn.ts`
 * collapses an internal-timeout abort and a parent-turn cancellation into
 * the same `aborted` string, so we disambiguate using the parent signal:
 * aborted -> the turn ended before the critic finished; otherwise the
 * critic's own wall-clock timeout fired. Mirrors enhance.ts.
 */
function describeNonCompletion(result: CritiqueRunResult, parentAborted: boolean, timeoutMs: number): string {
  if (result.stopReason === 'aborted') {
    return parentAborted
      ? 'aborted: parent turn ended before the critic finished (a faster refineModel shrinks this window)'
      : `timed out after ${timeoutMs}ms (set a faster refineModel or raise refineTimeoutMs)`;
  }
  return `stop=${result.stopReason}: ${result.errorMessage ?? '(no message)'}`;
}

/**
 * Build a {@link Refiner} from a fully-resolved wiring. Call once (lazily
 * on first use); reuse the returned object for the process. Mirrors
 * {@link createEnhancer} but on the OUTPUT side: resolve the (vision-capable)
 * model, build the critic task, spawn one-shot, parse the decision.
 */
export function createRefiner<M>(wiring: RefinerWiring<M>): Refiner<M> {
  const timeoutMs = wiring.timeoutMs ?? DEFAULT_REFINE_TIMEOUT_MS;

  const isEnabled = (): boolean => wiring.criticAgent !== null;

  return {
    isEnabled,

    async critique(ctx, input) {
      const agent = wiring.criticAgent;
      if (!agent) return null;
      if (input.imagePath.trim().length === 0) return null;

      const resolution = resolveChildModel({
        override: wiring.settings?.refineModel,
        agent,
        parent: ctx.model,
        modelRegistry: ctx.modelRegistry,
      });
      if (!resolution.ok) {
        report(wiring, 'info', `refine model resolution failed: ${resolution.error}`);
        return null;
      }
      if (!wiring.isVisionModel(resolution.model)) {
        report(wiring, 'info', 'resolved refine model has no vision capability; skipping refine');
        return null;
      }

      const task = buildCritiqueTask({
        imagePath: input.imagePath,
        request: input.request,
        availableActions: input.availableActions,
        ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
      });

      let result: CritiqueRunResult;
      try {
        result = await wiring.runOneShot({
          cwd: ctx.cwd,
          agent,
          model: resolution.model,
          modelRegistry: ctx.modelRegistry,
          task,
          signal: ctx.signal,
          timeoutMs,
        });
      } catch (e) {
        report(wiring, 'info', `refine spawn error: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }

      if (result.stopReason !== 'completed') {
        report(wiring, 'info', describeNonCompletion(result, ctx.signal?.aborted === true, timeoutMs));
        return null;
      }

      const decision = parseCriticDecision(result.finalText);
      if (decision === null) {
        report(wiring, 'info', 'critic produced no usable JSON; skipping refine this round');
        return null;
      }
      report(wiring, 'debug', `critique \u2192 ${decision.verdict} (score ${decision.score})`);
      return decision;
    },
  };
}
