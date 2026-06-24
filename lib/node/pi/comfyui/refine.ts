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
import { isFiniteNumber, isNonEmptyString, isRecord } from '../shared.ts';

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
