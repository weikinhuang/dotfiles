/**
 * Scene-event ("complication") generator for the `roleplay` extension.
 *
 * `/roleplay event [hint]` queues a one-shot in-world complication that
 * is injected as an ephemeral director note for the next reply only
 * (additive - it never rewrites the transcript). The event is produced
 * either by a one-shot subagent (the `roleplay-event` agent, default and
 * whenever a hint is given) or, as a fallback, by drawing from a
 * user-supplied deck in `roleplay.json`.
 *
 * Mirrors `summarize.ts`: pure helpers (task builder, director framing,
 * deck pick, validation) + a settings resolver + an adapter factory that
 * takes the pi deps via a wiring. Tests construct a wiring with a mock
 * `runOneShot`; production wires `runOneShotAgent`.
 *
 * One deliberate difference from the summarizer: a missing `eventModel`
 * does NOT disable the generator - it falls back to the parent session
 * model (a complication is a normal turn-cost feature, not a separate
 * credential choice). The generator is disabled only when the
 * `roleplay-event` agent is not installed.
 *
 * No pi imports (only the pi-free `resolveChildModel` /
 * `ModelRegistryLike` types from `../subagent/spawn.ts`).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { readJsoncOrUndefined } from '../fs-safe.ts';
import { parseModelSpec } from '../model-spec.ts';
import { isRecord, truncate } from '../shared.ts';
import { type AgentDef } from '../subagent/loader.ts';
import { resolveChildModel, type ModelRegistryLike } from '../subagent/spawn.ts';

// ──────────────────────────────────────────────────────────────────────
// Pure helpers: task builder + director framing + deck pick + validation
// ──────────────────────────────────────────────────────────────────────

export interface EventTaskOpts {
  /** Role-prefixed recent scene text (continuity for tone-matching). */
  recentScene: string;
  /** One-line cast descriptors (name: description) so the event fits the characters. */
  sheets: readonly string[];
  /** Dangling relationship threads the event may escalate instead of inventing cold. */
  openThreads: readonly string[];
  /** Optional freeform steer from `/roleplay event <hint>`. */
  hint?: string;
  /** When true, offer `openThreads` to the generator as escalation seeds. */
  seedThreads: boolean;
}

/**
 * Build the task prompt for the `roleplay-event` agent: hand it the cast,
 * the recent scene, (optionally) the open threads, and any hint, and ask
 * for ONE short complication to introduce - not resolve - next turn.
 */
export function buildEventTask(opts: EventTaskOpts): string {
  const parts: string[] = [];
  const sheets = opts.sheets.map((s) => s.trim()).filter((s) => s.length > 0);
  if (sheets.length > 0) parts.push(`Cast in this scenario:\n${sheets.map((s) => `- ${s}`).join('\n')}`);
  if (opts.seedThreads) {
    const threads = opts.openThreads.map((t) => t.trim()).filter((t) => t.length > 0);
    if (threads.length > 0) {
      parts.push(
        `Open threads you MAY escalate instead of inventing something cold:\n${threads.map((t) => `- ${t}`).join('\n')}`,
      );
    }
  }
  const scene = opts.recentScene.trim();
  parts.push(`Recent scene:\n${scene.length > 0 ? scene : '(the scene has just opened)'}`);
  const hint = opts.hint?.trim();
  if (hint) parts.push(`Steer the complication toward: ${hint}`);
  parts.push(
    'Write ONE short in-world complication or development that fits the current tone, genre, and characters, ' +
      'for the scene partner to weave into their next reply. Introduce it; do NOT resolve it, do NOT railroad the ' +
      'outcome, and do NOT offer options or meta commentary. One or two sentences of plain prose, no headings, no ' +
      'OOC. If nothing fits the scene, reply with the literal string null.',
  );
  return parts.join('\n\n');
}

/**
 * Frame a resolved event as the ephemeral director note injected for the
 * next reply. Phrased so the model treats it as a private stage
 * direction, not as dialogue to echo.
 */
export function formatEventDirector(event: string): string {
  return (
    'Director note (private; do not quote or announce this) - introduce the following development naturally ' +
    `in your next reply, in character:\n${event.trim()}`
  );
}

/**
 * Pick a deck entry at random (the no-model fallback). Returns
 * `undefined` for an empty / all-blank deck so the caller can report
 * that nothing is available.
 */
export function pickDeckEvent(deck: readonly string[], rng: () => number = Math.random): string | undefined {
  const items = deck.map((s) => s.trim()).filter((s) => s.length > 0);
  if (items.length === 0) return undefined;
  const idx = Math.min(items.length - 1, Math.max(0, Math.floor(rng() * items.length)));
  return items[idx];
}

/**
 * Validate a generated event. Returns the trimmed text, or `null` for an
 * empty response or the literal `null` sentinel. An over-long response
 * is truncated to `maxChars` (a complication is meant to be a one-liner,
 * so a slightly long one is still usable - unlike a recap, which is
 * dropped wholesale).
 */
export function validateEvent(raw: string, maxChars: number): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === 'null') return null;
  return trimmed.length > maxChars ? truncate(trimmed, maxChars) : trimmed;
}

// ──────────────────────────────────────────────────────────────────────
// Settings resolution (separate eventModel, mirrors summarizeModel)
// ──────────────────────────────────────────────────────────────────────

export interface EventSettings {
  /** Resolved model spec of the form `provider/model-id`. */
  eventModel: string;
  /** Which file produced the winning value - useful for diagnostics. */
  source: string;
}

export interface ResolveEventSettingsOpts {
  cwd: string;
  /** Override for `~` - lets tests point at a temp home. Defaults to `os.homedir()`. */
  home?: string;
}

function parseEventModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseModelSpec(raw);
  if (!parsed) return null;
  return `${parsed.provider}/${parsed.modelId}`;
}

/**
 * Resolve the optional `eventModel` from, in order:
 *
 *   1. `<cwd>/.pi/roleplay-event.json` - `{eventModel: "…"}` or a bare string.
 *   2. `<home>/.pi/agent/roleplay-event.json` - same shape.
 *   3. `<home>/.pi/agent/settings.json` - under `roleplay.eventModel`.
 *
 * First hit wins. Returns `null` when none resolve - the generator then
 * inherits the parent session model (it is NOT disabled).
 */
export function resolveEventSettings(opts: ResolveEventSettingsOpts): EventSettings | null {
  const home = opts.home ?? homedir();
  const candidates: { path: string; extract: (v: unknown) => unknown }[] = [
    {
      path: join(opts.cwd, '.pi', 'roleplay-event.json'),
      extract: (v) => (isRecord(v) ? v.eventModel : v),
    },
    {
      path: join(home, '.pi', 'agent', 'roleplay-event.json'),
      extract: (v) => (isRecord(v) ? v.eventModel : v),
    },
    {
      path: join(home, '.pi', 'agent', 'settings.json'),
      extract: (v) => {
        if (!isRecord(v)) return undefined;
        const roleplay = v.roleplay;
        if (!isRecord(roleplay)) return undefined;
        return roleplay.eventModel;
      },
    },
  ];

  for (const candidate of candidates) {
    const body = readJsoncOrUndefined(candidate.path);
    if (body === undefined) continue;
    const value = parseEventModel(candidate.extract(body));
    if (value !== null) return { eventModel: value, source: candidate.path };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Adapter factory
// ──────────────────────────────────────────────────────────────────────

/** Result of a one-shot event run, as returned by `runOneShotAgent`. */
export interface EventRunResult {
  finalText: string;
  /** One of `completed | max_turns | aborted | error`. */
  stopReason: string;
  errorMessage?: string;
}

/**
 * Shim over `runOneShotAgent` - tests replace this with a mock that
 * returns scripted `EventRunResult` values without spawning anything.
 */
export type EventRunOneShot<M> = (args: {
  cwd: string;
  agent: AgentDef;
  model: M;
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  task: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<EventRunResult>;

/** Structural parent-context the adapter needs to spawn a child. */
export interface EventContext<M> {
  cwd: string;
  /** Parent's current model - inherited when settings don't override. */
  model: M | undefined;
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  /** Parent signal. */
  signal?: AbortSignal;
}

/** Everything the adapter needs from the pi runtime + environment. */
export interface EventGeneratorWiring<M> {
  /** Resolved model override. `null` → inherit the parent model (NOT disabled). */
  settings: EventSettings | null;
  /** Loaded `roleplay-event` agent. `null` → generator disabled (agent not installed). */
  eventAgent: AgentDef | null;
  /** One-shot spawner. Usually `runOneShotAgent` wrapped. */
  runOneShot: EventRunOneShot<M>;
  /** Optional diagnostic sink - non-fatal errors are reported here. */
  log?: (level: 'info' | 'warn', message: string) => void;
  /** Soft cap on the event body, in characters. Default 280. */
  maxOutputChars?: number;
  /** Per-call agent timeout, in ms. Default 60000. */
  timeoutMs?: number;
}

export interface EventGenerator<M = unknown> {
  isEnabled(): boolean;
  /**
   * Generate one event for `task`. Returns the event string, or `null`
   * on ANY failure (disabled, model-resolution failure, spawn error,
   * non-`completed` stop, empty / `null` response).
   */
  generate(ctx: EventContext<M>, task: string): Promise<string | null>;
}

const DEFAULT_MAX_OUTPUT_CHARS = 280;
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
 * Build an {@link EventGenerator} from a fully-resolved wiring. Call once
 * (lazily on first use); reuse the returned object for the process.
 */
export function createEventGenerator<M>(wiring: EventGeneratorWiring<M>): EventGenerator<M> {
  const maxOutput = wiring.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const timeoutMs = wiring.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const isEnabled = (): boolean => wiring.eventAgent !== null;

  return {
    isEnabled,

    async generate(ctx, task) {
      const agent = wiring.eventAgent;
      if (!agent) return null;
      if (task.trim().length === 0) return null;

      const resolution = resolveChildModel({
        override: wiring.settings?.eventModel,
        agent,
        parent: ctx.model,
        modelRegistry: ctx.modelRegistry,
      });
      if (!resolution.ok) {
        report(wiring, 'info', `event model resolution failed: ${resolution.error}`);
        return null;
      }

      let result: EventRunResult;
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
        report(wiring, 'info', `event spawn error: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }

      if (result.stopReason !== 'completed') {
        report(wiring, 'info', `event stop=${result.stopReason}: ${result.errorMessage ?? '(no message)'}`);
        return null;
      }

      return validateEvent(result.finalText, maxOutput);
    },
  };
}
