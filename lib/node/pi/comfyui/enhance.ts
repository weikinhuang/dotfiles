/**
 * Prompt enhancer for the `comfyui` extension: an opt-in, agent-driven
 * refinement of a user prompt + negative into the target workflow's native
 * protocol (booru tags for an anime model, natural language for FLUX, …).
 *
 * Mirrors the roleplay-event generator end to end
 * ([../roleplay/event.ts](../roleplay/event.ts)): pure helpers (task
 * builder + tolerant result parse), a model resolver, and a
 * {@link createEnhancer} factory that takes the pi deps via a wiring so
 * tests inject a mock `runOneShot` instead of spawning a child agent.
 *
 * The enhancer NORMALIZES + TRANSLATES + REFINES: it accepts whatever the
 * main model sent (protocol-native tags or loose natural language) and
 * emits the target protocol as described by the guidance docs /
 * `promptProtocol`. It never blocks a render - any failure (agent missing,
 * model resolution failure, spawn/parse error, non-`completed` stop) makes
 * the caller fall back to the original prompt + baseline negative.
 *
 * No pi imports (only the pi-free `resolveChildModel` / `ModelRegistryLike`
 * types from `../subagent/spawn.ts`).
 */

import { parseModelSpec } from '../model-spec.ts';
import { parseJsonLoose, stripCodeFence } from '../json-loose.ts';
import { truncate } from '../shared.ts';
import { type AgentDef } from '../subagent/loader.ts';
import { resolveChildModel, type ModelRegistryLike } from '../subagent/spawn.ts';

// ──────────────────────────────────────────────────────────────────────
// Pure helpers: task builder + tolerant result parse
// ──────────────────────────────────────────────────────────────────────

export interface EnhanceTaskOpts {
  /** The user's positive prompt (protocol-native tags or natural language). */
  prompt: string;
  /** Baseline negative to refine (user negative ?? config default). */
  negative?: string;
  /**
   * Concatenated guidance text (global-first, then per-workflow) telling
   * the enhancer how to phrase for this image model. When empty, the
   * builder falls back to `description` / `tags` / `promptProtocol`.
   */
  guidance?: string;
  /** Workflow description, used as light guidance when no guidance doc exists. */
  description?: string;
  /** Workflow tags, surfaced as extra hints. */
  tags?: readonly string[];
  /** Target prompting protocol (e.g. "Danbooru tags, comma-separated"). */
  promptProtocol?: string;
  /**
   * Per-call dynamic background to honor but not necessarily depict
   * literally (scene / continuity / character facts). Distinct from the
   * literal subject (`prompt`) and the static how-to-phrase guidance.
   */
  context?: string;
}

function cleanList(items: readonly string[] | undefined): string[] {
  return (items ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Build the task prompt for the `comfyui-enhance` agent: hand it the
 * guidance, the target protocol, any background context, the prompt to
 * enhance, and the baseline negative, then ask for a JSON object back.
 */
export function buildEnhanceTask(opts: EnhanceTaskOpts): string {
  const parts: string[] = [];

  const guidance = opts.guidance?.trim();
  if (guidance !== undefined && guidance.length > 0) {
    parts.push(
      'Guidance for prompting this image model (authoritative - follow it, and let it override any default):\n' +
        guidance,
    );
  } else {
    const description = opts.description?.trim();
    const descSuffix = description !== undefined && description.length > 0 ? ` Target workflow: ${description}.` : '';
    parts.push(
      'No model-specific guidance was provided - rely on the target protocol and your general knowledge of how to ' +
        `prompt this kind of model.${descSuffix}`,
    );
  }

  const tags = cleanList(opts.tags);
  if (tags.length > 0) parts.push(`Workflow tags: ${tags.join(', ')}`);

  const protocol = opts.promptProtocol?.trim();
  if (protocol !== undefined && protocol.length > 0) {
    parts.push(`Emit the positive and negative in this protocol: ${protocol}`);
  }

  const context = opts.context?.trim();
  if (context !== undefined && context.length > 0) {
    parts.push(
      'Background to honor (do NOT necessarily depict it literally; use it to disambiguate and keep continuity):\n' +
        context,
    );
  }

  parts.push(`Positive prompt to enhance:\n${opts.prompt.trim()}`);

  const negative = opts.negative?.trim();
  parts.push(`Baseline negative prompt:\n${negative !== undefined && negative.length > 0 ? negative : '(none)'}`);

  parts.push(
    'Return ONLY a JSON object of the form {"prompt": "<enhanced positive>", "negative": "<enhanced negative>"}. ' +
      "Refine, translate, and enrich the positive into the protocol above; keep the user's intent. For the negative, " +
      'build on the baseline. Output nothing but the JSON object - no prose, no code fence.',
  );

  return parts.join('\n\n');
}

export interface EnhanceResult {
  prompt: string;
  negative?: string;
}

/**
 * Tolerantly parse the enhancer's final text into an {@link EnhanceResult},
 * or `null` on any failure so the caller falls back to the raw prompt.
 * Never throws.
 *
 * Accepts clean JSON, a fenced block (tagged or not), and JSON embedded in
 * surrounding prose. Requires a non-empty `prompt`; takes `negative` only
 * when it is a non-empty string; ignores extra keys; caps both fields to
 * `maxChars`.
 */
export function parseEnhanceResult(raw: string, maxChars: number): EnhanceResult | null {
  const unfenced = stripCodeFence(raw);
  if (unfenced.length === 0) return null;

  const parsed = parseJsonLoose(unfenced);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const promptValue = record.prompt;
  if (typeof promptValue !== 'string') return null;
  const prompt = promptValue.trim();
  if (prompt.length === 0) return null;

  const result: EnhanceResult = { prompt: truncate(prompt, maxChars) };

  const negativeValue = record.negative;
  if (typeof negativeValue === 'string') {
    const negative = negativeValue.trim();
    if (negative.length > 0) result.negative = truncate(negative, maxChars);
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Model resolution
// ──────────────────────────────────────────────────────────────────────

export interface EnhanceSettings {
  /** Resolved model spec of the form `provider/model-id`. */
  enhanceModel: string;
}

/**
 * Validate a configured `enhanceModel` spec into a `provider/model-id`
 * string, or `null` when absent / malformed. A `null` result means the
 * enhancer inherits the parent session model (it is NOT disabled), exactly
 * like the roleplay-event generator.
 */
export function resolveEnhanceModel(raw: string | undefined): EnhanceSettings | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseModelSpec(raw);
  if (!parsed) return null;
  return { enhanceModel: `${parsed.provider}/${parsed.modelId}` };
}

// ──────────────────────────────────────────────────────────────────────
// Adapter factory
// ──────────────────────────────────────────────────────────────────────

/** Result of a one-shot enhance run, as returned by `runOneShotAgent`. */
export interface EnhanceRunResult {
  finalText: string;
  /** One of `completed | max_turns | aborted | error`. */
  stopReason: string;
  errorMessage?: string;
}

/**
 * Diagnostic verbosity levels. `debug` is the success / fired-OK channel
 * (low value, gated behind a debug env at the call site); `info` / `warn`
 * are always-surfaced problems the user should see.
 */
export type EnhanceLogLevel = 'debug' | 'info' | 'warn';

/**
 * Turn a non-`completed` run into an actionable diagnostic. `spawn.ts`
 * collapses an internal-timeout abort and a parent-turn cancellation into
 * the same `aborted: aborted` string, so we disambiguate here using the
 * parent signal: when it is aborted the enhancer was cut off by the turn
 * ending (the caller sent the next message); otherwise the enhancer's own
 * wall-clock timeout fired.
 */
function describeNonCompletion(result: EnhanceRunResult, parentAborted: boolean, timeoutMs: number): string {
  if (result.stopReason === 'aborted') {
    return parentAborted
      ? 'aborted: parent turn ended before the enhancer finished (a faster enhanceModel shrinks this window)'
      : `timed out after ${timeoutMs}ms (set a faster enhanceModel or raise enhanceTimeoutMs)`;
  }
  return `stop=${result.stopReason}: ${result.errorMessage ?? '(no message)'}`;
}

/**
 * Shim over `runOneShotAgent` - tests replace this with a mock returning
 * scripted `EnhanceRunResult` values without spawning anything.
 */
export type EnhanceRunOneShot<M> = (args: {
  cwd: string;
  agent: AgentDef;
  model: M;
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  task: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<EnhanceRunResult>;

/** Structural parent-context the adapter needs to spawn a child. */
export interface EnhanceContext<M> {
  cwd: string;
  /** Parent's current model - inherited when settings don't override. */
  model: M | undefined;
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  /** Parent signal. */
  signal?: AbortSignal;
}

/** Everything the adapter needs from the pi runtime + environment. */
export interface EnhancerWiring<M> {
  /** Resolved model override. `null` → inherit the parent model (NOT disabled). */
  settings: EnhanceSettings | null;
  /** Loaded `comfyui-enhance` agent. `null` → enhancer disabled (agent not installed). */
  enhanceAgent: AgentDef | null;
  /** One-shot spawner. Usually `runOneShotAgent` wrapped. */
  runOneShot: EnhanceRunOneShot<M>;
  /** Optional diagnostic sink - non-fatal errors are reported here. */
  log?: (level: EnhanceLogLevel, message: string) => void;
  /** Soft cap per field, in characters. Default 2000. */
  maxOutputChars?: number;
  /** Per-call agent timeout, in ms. Default 30000. */
  timeoutMs?: number;
}

export interface Enhancer<M = unknown> {
  isEnabled(): boolean;
  /**
   * Enhance one prompt for `task`. Returns the {@link EnhanceResult}, or
   * `null` on ANY failure (disabled, model-resolution failure, spawn
   * error, non-`completed` stop, unparseable output) so the caller keeps
   * the original prompt + baseline negative.
   */
  enhance(ctx: EnhanceContext<M>, task: string): Promise<EnhanceResult | null>;
}

const DEFAULT_MAX_OUTPUT_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 30000;

function report(
  wiring: { log?: (level: EnhanceLogLevel, message: string) => void },
  level: EnhanceLogLevel,
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
 * Build an {@link Enhancer} from a fully-resolved wiring. Call once
 * (lazily on first use); reuse the returned object for the process.
 */
export function createEnhancer<M>(wiring: EnhancerWiring<M>): Enhancer<M> {
  const maxOutput = wiring.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const timeoutMs = wiring.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const isEnabled = (): boolean => wiring.enhanceAgent !== null;

  return {
    isEnabled,

    async enhance(ctx, task) {
      const agent = wiring.enhanceAgent;
      if (!agent) return null;
      if (task.trim().length === 0) return null;

      const resolution = resolveChildModel({
        override: wiring.settings?.enhanceModel,
        agent,
        parent: ctx.model,
        modelRegistry: ctx.modelRegistry,
      });
      if (!resolution.ok) {
        report(wiring, 'info', `enhance model resolution failed: ${resolution.error}`);
        return null;
      }

      let result: EnhanceRunResult;
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
        report(wiring, 'info', `enhance spawn error: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }

      if (result.stopReason !== 'completed') {
        report(wiring, 'info', describeNonCompletion(result, ctx.signal?.aborted === true, timeoutMs));
        return null;
      }

      const parsed = parseEnhanceResult(result.finalText, maxOutput);
      if (parsed === null) {
        report(wiring, 'info', 'produced no usable JSON; keeping the original prompt');
        return null;
      }
      report(wiring, 'debug', `enhanced → ${truncate(parsed.prompt, 160)}`);
      return parsed;
    },
  };
}
