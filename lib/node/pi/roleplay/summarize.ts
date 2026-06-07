/**
 * Auto-summarization adapter for the `roleplay` extension. Optional,
 * opt-in, non-load-bearing plumbing that folds the message span pi is
 * about to evict (the `session_before_compact` `messagesToSummarize`)
 * into a durable `summary` record in the active cast store, so scene
 * continuity survives compaction.
 *
 * It is a strict SIDE-write. It never provides or overrides pi's own
 * compaction summary - if anything here fails, pi compacts exactly as
 * it would without the extension. `null` is the one "please fall back"
 * signal across the whole surface:
 *
 *   - settings do not resolve a `summarizeModel`      -> adapter disabled
 *   - the `roleplay-summarizer` agent is not installed  -> adapter disabled
 *   - the span is too small / empty                     -> `planSummarization` returns null
 *   - child model resolution fails / agent throws /
 *     times out / returns the literal `null` / returns
 *     empty                                             -> `summarize` returns null
 *
 * On any `null` the caller writes nothing and the turn proceeds.
 *
 * Mirrors the structure of `lib/node/pi/research/tiny.ts`: pure
 * helpers + a settings resolver + an adapter factory that takes a
 * wiring carrying the pi deps. Tests construct a wiring with a mock
 * `runOneShot`; production wires `runOneShotAgent`.
 *
 * No pi imports (only the pi-free `resolveChildModel` /
 * `ModelRegistryLike` types from `../subagent/spawn.ts`).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { readJsoncOrUndefined } from '../fs-safe.ts';
import { parseModelSpec } from '../model-spec.ts';
import { isRecord } from '../shared.ts';
import { type AgentDef } from '../subagent/loader.ts';
import { resolveChildModel, type ModelRegistryLike } from '../subagent/spawn.ts';

// ──────────────────────────────────────────────────────────────────────
// Pure helpers: span rendering + trigger + validation + record shaping
// ──────────────────────────────────────────────────────────────────────

/** Minimal message shape the planner consumes (role + flattened text). */
export interface SummarizableMessage {
  role: string;
  text: string;
}

export interface PlanSummarizationOpts {
  /** Minimum non-empty messages required before summarizing. Default 4. */
  minMessages?: number;
  /** Soft cap on the rendered span fed to the model, in characters. Default 8000. */
  maxSpanChars?: number;
}

export interface SummarizationPlan {
  /** Role-prefixed transcript of the span, head-truncated to the char cap. */
  spanText: string;
  /** Count of non-empty messages that went into the span. */
  messageCount: number;
}

const DEFAULT_MIN_MESSAGES = 4;
const DEFAULT_MAX_SPAN_CHARS = 8000;
const TRUNCATION_MARKER = '[...earlier turns omitted...]';

/**
 * Render a message span into a compact role-prefixed transcript. When
 * the joined text exceeds `maxChars`, the OLDEST lines are dropped
 * (they are the least useful for a "what just happened" recap) and a
 * marker is prepended. Always returns the most recent content.
 */
export function renderSpan(
  messages: readonly SummarizableMessage[],
  maxChars: number = DEFAULT_MAX_SPAN_CHARS,
): string {
  const lines: string[] = [];
  for (const m of messages) {
    const text = m.text.trim();
    if (text.length === 0) continue;
    lines.push(`${m.role}: ${text}`);
  }
  let joined = lines.join('\n\n');
  if (joined.length <= maxChars) return joined;

  // Drop from the front (oldest) until we fit, keeping the marker.
  const kept: string[] = [];
  let budget = maxChars - TRUNCATION_MARKER.length - 2;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.length + 2 > budget) break;
    kept.unshift(line);
    budget -= line.length + 2;
  }
  joined = `${TRUNCATION_MARKER}\n\n${kept.join('\n\n')}`;
  return joined;
}

/**
 * Decide whether the evicted span is worth summarizing. Returns the
 * rendered span + non-empty message count, or `null` when fewer than
 * `minMessages` non-empty messages are present (a tiny span is not
 * worth a model call - the caller falls back to writing nothing).
 */
export function planSummarization(
  messages: readonly SummarizableMessage[],
  opts: PlanSummarizationOpts = {},
): SummarizationPlan | null {
  const minMessages = opts.minMessages ?? DEFAULT_MIN_MESSAGES;
  const maxSpanChars = opts.maxSpanChars ?? DEFAULT_MAX_SPAN_CHARS;
  const nonEmpty = messages.filter((m) => m.text.trim().length > 0);
  if (nonEmpty.length < minMessages) return null;
  const spanText = renderSpan(nonEmpty, maxSpanChars);
  if (spanText.trim().length === 0) return null;
  return { spanText, messageCount: nonEmpty.length };
}

/**
 * Build the task prompt for the `roleplay-summarizer` agent. When a
 * `priorSummary` exists, the agent is asked to fold the new span into
 * it (consolidate, not append), so the rolling record stays bounded.
 */
export function buildSummarizeTask(spanText: string, priorSummary?: string): string {
  const prior =
    priorSummary && priorSummary.trim().length > 0
      ? `Existing running recap (update it; do not just append):\n${priorSummary.trim()}\n\n`
      : '';
  return (
    `${prior}New conversation span to fold into the recap:\n${spanText}\n\n` +
    'Write a tight third-person recap of the roleplay so far: who is present, what happened, ' +
    'unresolved threads, and the current emotional tone. Prose only, no headings or lists, ' +
    'no meta commentary. If there is nothing substantive to record, reply with the literal string null.'
  );
}

/**
 * Validate a model recap response. Returns the trimmed text, or `null`
 * when the response is empty, the literal `null` sentinel, or exceeds
 * `maxChars` (a runaway response is dropped rather than truncated, so a
 * half-formed recap never lands on disk).
 */
export function validateSummary(raw: string, maxChars: number): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === 'null') return null;
  if (trimmed.length > maxChars) return null;
  return trimmed;
}

export interface AutoSummaryRecord {
  /** Fixed slug - the rolling auto-summary record id. */
  id: string;
  name: string;
  description: string;
  body: string;
}

/** Fixed id/slug of the rolling auto-summary record per cast. */
export const AUTO_SUMMARY_ID = 'auto';

/**
 * Shape the validated recap into a `summary` record. A single rolling
 * record per cast (`summary/auto.md`) is overwritten each time so the
 * store stays bounded; the date in the description tracks freshness.
 */
export function composeAutoSummaryRecord(summary: string, now: Date = new Date()): AutoSummaryRecord {
  const date = now.toISOString().slice(0, 10);
  return {
    id: AUTO_SUMMARY_ID,
    name: 'Auto recap',
    description: `Running scene recap, auto-updated ${date}`,
    body: summary.trim(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Settings resolution
// ──────────────────────────────────────────────────────────────────────

export interface SummarizeSettings {
  /** Resolved model spec of the form `provider/model-id`. */
  summarizeModel: string;
  /** Which file produced the winning value - useful for diagnostics. */
  source: string;
}

export interface ResolveSummarizeSettingsOpts {
  cwd: string;
  /** Override for `~` - lets tests point at a temp home. Defaults to `os.homedir()`. */
  home?: string;
}

function parseSummarizeModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseModelSpec(raw);
  if (!parsed) return null;
  return `${parsed.provider}/${parsed.modelId}`;
}

/**
 * Resolve the `summarizeModel` setting from, in order:
 *
 *   1. `<cwd>/.pi/roleplay-summarize.json` - `{summarizeModel: "…"}` or a
 *      bare string.
 *   2. `<home>/.pi/agent/roleplay-summarize.json` - same shape.
 *   3. `<home>/.pi/agent/settings.json` - under `roleplay.summarizeModel`.
 *
 * First hit wins. Returns `null` when none resolve a non-empty
 * `provider/model` string (adapter then stays disabled).
 */
export function resolveSummarizeSettings(opts: ResolveSummarizeSettingsOpts): SummarizeSettings | null {
  const home = opts.home ?? homedir();
  const candidates: { path: string; extract: (v: unknown) => unknown }[] = [
    {
      path: join(opts.cwd, '.pi', 'roleplay-summarize.json'),
      extract: (v) => (isRecord(v) ? v.summarizeModel : v),
    },
    {
      path: join(home, '.pi', 'agent', 'roleplay-summarize.json'),
      extract: (v) => (isRecord(v) ? v.summarizeModel : v),
    },
    {
      path: join(home, '.pi', 'agent', 'settings.json'),
      extract: (v) => {
        if (!isRecord(v)) return undefined;
        const roleplay = v.roleplay;
        if (!isRecord(roleplay)) return undefined;
        return roleplay.summarizeModel;
      },
    },
  ];

  for (const candidate of candidates) {
    const body = readJsoncOrUndefined(candidate.path);
    if (body === undefined) continue;
    const value = parseSummarizeModel(candidate.extract(body));
    if (value !== null) {
      return { summarizeModel: value, source: candidate.path };
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Adapter factory
// ──────────────────────────────────────────────────────────────────────

/** Result of a one-shot summarizer run, as returned by `runOneShotAgent`. */
export interface SummarizeRunResult {
  finalText: string;
  /** One of `completed | max_turns | aborted | error`. */
  stopReason: string;
  errorMessage?: string;
}

/**
 * Shim over `runOneShotAgent` - tests replace this with a mock that
 * returns scripted `SummarizeRunResult` values without spawning
 * anything. Production wires through `subagent/spawn.runOneShotAgent`.
 */
export type SummarizeRunOneShot<M> = (args: {
  cwd: string;
  agent: AgentDef;
  model: M;
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  task: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<SummarizeRunResult>;

/** Structural parent-context the adapter needs to spawn a child. */
export interface SummarizeContext<M> {
  cwd: string;
  /** Parent's current model - inherited when settings don't override. */
  model: M | undefined;
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  /** Parent turn / compaction signal. */
  signal?: AbortSignal;
}

/** Everything the adapter needs from the pi runtime + environment. */
export interface SummarizerWiring<M> {
  /** Resolved settings. `null` → adapter permanently disabled. */
  settings: SummarizeSettings | null;
  /**
   * Loaded `roleplay-summarizer` agent definition. `null` → adapter
   * permanently disabled (agent not installed).
   */
  summarizerAgent: AgentDef | null;
  /** One-shot spawner. Usually `runOneShotAgent` wrapped. */
  runOneShot: SummarizeRunOneShot<M>;
  /** Optional diagnostic sink - non-fatal errors are reported here. */
  log?: (level: 'info' | 'warn', message: string) => void;
  /** Soft cap on the recap body, in characters. Default 1500. */
  maxOutputChars?: number;
  /** Per-call agent timeout, in ms. Default 60000. */
  timeoutMs?: number;
}

export interface Summarizer<M = unknown> {
  isEnabled(): boolean;
  /**
   * Fold `spanText` (+ optional running recap) into an updated recap.
   * Returns the recap string, or `null` on ANY failure (disabled,
   * model-resolution failure, spawn error, non-`completed` stop, empty
   * / `null` / over-cap response).
   */
  summarize(ctx: SummarizeContext<M>, spanText: string, priorSummary?: string): Promise<string | null>;
}

const DEFAULT_MAX_OUTPUT_CHARS = 1500;
const DEFAULT_TIMEOUT_MS = 60000;

function report(
  wiring: { log?: (level: 'info' | 'warn', message: string) => void },
  level: 'info' | 'warn',
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
 * Build a {@link Summarizer} from a fully-resolved wiring. Call once at
 * extension startup (or lazily on first compaction); reuse the returned
 * object for the process.
 */
export function createSummarizer<M>(wiring: SummarizerWiring<M>): Summarizer<M> {
  const maxOutput = wiring.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const timeoutMs = wiring.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const isEnabled = (): boolean => wiring.settings !== null && wiring.summarizerAgent !== null;

  return {
    isEnabled,

    async summarize(ctx, spanText, priorSummary) {
      const agent = wiring.summarizerAgent;
      const settings = wiring.settings;
      if (!agent || !settings) return null;
      if (spanText.trim().length === 0) return null;

      const resolution = resolveChildModel({
        override: settings.summarizeModel,
        agent,
        parent: ctx.model,
        modelRegistry: ctx.modelRegistry,
      });
      if (!resolution.ok) {
        report(wiring, 'info', `summarizer model resolution failed: ${resolution.error}`);
        return null;
      }

      let result: SummarizeRunResult;
      try {
        result = await wiring.runOneShot({
          cwd: ctx.cwd,
          agent,
          model: resolution.model,
          modelRegistry: ctx.modelRegistry,
          task: buildSummarizeTask(spanText, priorSummary),
          signal: ctx.signal,
          timeoutMs,
        });
      } catch (e) {
        report(wiring, 'info', `summarizer spawn error: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }

      if (result.stopReason !== 'completed') {
        report(wiring, 'info', `summarizer stop=${result.stopReason}: ${result.errorMessage ?? '(no message)'}`);
        return null;
      }

      return validateSummary(result.finalText, maxOutput);
    },
  };
}
