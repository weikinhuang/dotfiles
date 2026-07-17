/**
 * Tiny-model adapter. Optional, opt-in, non-load-bearing plumbing
 * for narrow helper tasks (slug generation, title normalization,
 * URL type classification, fuzzy match, etc.) that have a
 * deterministic fallback when the model is unavailable.
 *
 *   - When settings do not resolve a `tinyModel`, every adapter
 *     function returns `null` immediately and callers take the
 *     deterministic path.
 *   - When the adapter returns `null` for ANY reason (settings
 *     unset, disabled by call-budget, model resolution failed,
 *     agent threw, timed out, returned `"null"`, returned an
 *     over-long or out-of-set string), callers fall back. `null`
 *     is the one "please fall back" signal across the whole
 *     adapter surface.
 *   - The adapter never wraps `callTyped`, never touches research
 *     content, never retries on `null`.
 *
 * The adapter is split into two layers:
 *
 *   1. Pure helpers:
 *        - {@link resolveTinySettings} - settings-file resolver.
 *        - {@link getCallCount}, {@link incrementCallCount},
 *          {@link shouldCall} - per-run call counter persisted
 *          under `<runRoot>/.tiny-count`.
 *      These have no pi dependencies. Tests exercise them directly.
 *
 *   2. Adapter factory ({@link createTinyAdapter}) - produces an
 *      object with `isEnabled`, `callTinyRewrite`,
 *      `callTinyClassify`, `callTinyMatch`, and friends. The
 *      factory takes a `TinyAdapterWiring` carrying the pi deps
 *      needed to spawn the `tiny-helper` subagent; the extension
 *      that owns the pi runtime wires it up once. Tests construct
 *      a wiring with a mock `runOneShotAgent`.
 *
 * Cost tracking: `message_end` assistant events expose
 * `usage.cost.total`. The adapter sums those into a per-run total
 * the caller can read via `getTotalCost()`. Missing cost data is
 * tolerated - we do not fail the call, just under-count.
 */

import { existsSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFile } from '../atomic-write.ts';
import { parseModelSpec } from '../model-spec.ts';
import { readJsoncOrUndefined } from '../fs-safe.ts';
import { piAgentDir, piProjectPath } from '../pi-paths.ts';
import { type CostEventLike } from './cost-hook.ts';
import { appendJournal, type JournalLevel } from './journal.ts';
import { isRecord } from '../shared.ts';
import { type AgentDef } from '../subagent/loader.ts';
import { agentWithResolvedThinking, resolveChildModel, type ModelRegistryLike } from '../subagent/spawn.ts';

// ──────────────────────────────────────────────────────────────────────
// Settings resolution
// ──────────────────────────────────────────────────────────────────────

export interface TinySettings {
  /** Resolved model spec of the form `provider/model-id`. */
  tinyModel: string;
  /** Which file produced the winning value - useful for diagnostics. */
  source: string;
}

export interface ResolveTinySettingsOpts {
  cwd: string;
  /** Override for `~` - lets tests point at a temp home. Defaults to `os.homedir()`. */
  home?: string;
}

/**
 * Validate + normalize a `provider/model-id` value. Delegates the
 * grammar check to `parseModelSpec` (the same helper the subagent /
 * iteration-loop paths use) so every setting that resolves here
 * goes through the same `provider/model-id` rules - non-empty
 * provider + non-empty model id, whitespace around the `/`
 * tolerated, normalized on return.
 */
function parseTinyModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseModelSpec(raw);
  if (!parsed) return null;
  return `${parsed.provider}/${parsed.modelId}`;
}

/**
 * Resolve the `tinyModel` setting from, in order:
 *
 *   1. `<cwd>/.pi/research-tiny.json` - `{tinyModel: "…"}` or a
 *      bare string.
 *   2. `<piAgentDir>/research-tiny.json` - same shape.
 *   3. `<piAgentDir>/settings.json` - under `research.tinyModel`.
 *
 * First hit wins. Returns `null` when none of the locations have a
 * non-empty `provider/model` string.
 */
export function resolveTinySettings(opts: ResolveTinySettingsOpts): TinySettings | null {
  const home = opts.home ?? homedir();
  const agentDir = piAgentDir(process.env, home);
  const candidates: { path: string; extract: (v: unknown) => unknown }[] = [
    {
      path: piProjectPath(opts.cwd, 'research-tiny.json'),
      extract: (v) => (isRecord(v) ? v.tinyModel : v),
    },
    {
      path: join(agentDir, 'research-tiny.json'),
      extract: (v) => (isRecord(v) ? v.tinyModel : v),
    },
    {
      path: join(agentDir, 'settings.json'),
      extract: (v) => {
        if (!isRecord(v)) return undefined;
        const research = v.research;
        if (!isRecord(research)) return undefined;
        return research.tinyModel;
      },
    },
  ];

  for (const candidate of candidates) {
    const body = readJsoncOrUndefined(candidate.path);
    if (body === undefined) continue;
    const value = parseTinyModel(candidate.extract(body));
    if (value !== null) {
      return { tinyModel: value, source: candidate.path };
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Per-run call counter (purely filesystem - no wiring needed)
// ──────────────────────────────────────────────────────────────────────

function counterPath(runRoot: string): string {
  return join(runRoot, '.tiny-count');
}

/**
 * Read the current call count for `runRoot`. Returns 0 when the
 * counter file does not exist or is unreadable - a corrupted
 * counter is equivalent to "fresh run" from the adapter's point of
 * view.
 */
export function getCallCount(runRoot: string): number {
  const path = counterPath(runRoot);
  if (!existsSync(path)) return 0;
  try {
    const body = readFileSync(path, 'utf8').trim();
    const n = Number.parseInt(body, 10);
    if (Number.isFinite(n) && n >= 0) return n;
    return 0;
  } catch {
    return 0;
  }
}

function counterLockPath(runRoot: string): string {
  return join(runRoot, '.tiny-count.lock');
}

/** Busy-wait `ms` milliseconds. Only used to back off on lock contention. */
function spinWait(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* deliberate short busy-wait - increments are infrequent and brief */
  }
}

/**
 * Run `fn` while holding a coarse cross-process lock on the counter.
 *
 * `mkdirSync` is atomic on POSIX and Windows: a second caller
 * (e.g. a parallel fanout process incrementing the SAME counter)
 * gets `EEXIST` and spins briefly before retrying. On persistent
 * contention - typically a stale lock left by a crashed process -
 * we give up after a bounded wait and run `fn` unlocked: the
 * counter is advisory, so a rare double-count is far better than a
 * deadlock that wedges the whole run.
 */
function withCounterLock<T>(runRoot: string, fn: () => T): T {
  const lock = counterLockPath(runRoot);
  const deadline = Date.now() + 250;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Unexpected error (e.g. runRoot missing) - don't wedge; run unlocked.
        return fn();
      }
      if (Date.now() >= deadline) return fn();
      spinWait(2);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* best-effort release */
    }
  }
}

/**
 * Atomically bump the counter and return the new value. Called
 * immediately before spawning the tiny-helper agent, so a failed
 * counter write shows up as a journal error rather than silent
 * budget overrun.
 *
 * The read-modify-write runs under {@link withCounterLock} so
 * concurrent adapter calls against the SAME runRoot (parallel
 * fanout) cannot both read the same value and each write `n+1`,
 * which previously let a run quietly exceed its tiny-call cap.
 */
export function incrementCallCount(runRoot: string): number {
  return withCounterLock(runRoot, () => {
    const next = getCallCount(runRoot) + 1;
    atomicWriteFile(counterPath(runRoot), `${next}\n`);
    return next;
  });
}

/**
 * True iff another tiny-helper call would fit within `maxCalls`
 * for `runRoot`. Consulted BEFORE `incrementCallCount` so a caller
 * that sees `false` can short-circuit with a journal warning
 * without spending its budget.
 */
export function shouldCall(runRoot: string, maxCalls: number): boolean {
  if (!Number.isFinite(maxCalls) || maxCalls <= 0) return false;
  return getCallCount(runRoot) < maxCalls;
}

// ──────────────────────────────────────────────────────────────────────
// Adapter factory
// ──────────────────────────────────────────────────────────────────────

/**
 * Structural shape of pi's `AgentSession` parent-context the
 * adapter needs to spawn a child. Matches the subset
 * `runOneShotAgent` consumes, plus `signal` for parent-driven
 * cancellation.
 */
export interface TinyCallContext<M> {
  cwd: string;
  /** Parent's current model - inherited when settings don't override. */
  model: M | undefined;
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  /** Parent turn signal. */
  signal?: AbortSignal;
  /**
   * Optional run-root. When provided, the adapter consults
   * {@link shouldCall} / {@link incrementCallCount} against this
   * directory. When omitted, the call counter is disabled for this
   * call (used by the rare "no run directory yet" path - e.g. the
   * slugify call that produces the run directory in the first place).
   */
  runRoot?: string;
  /** Per-run call cap. Required when `runRoot` is set. */
  maxCalls?: number;
}

/** Result of a one-shot tiny run, as returned by `runOneShotAgent`. */
export interface TinyRunResult {
  finalText: string;
  /** One of `completed | max_turns | aborted | error`. */
  stopReason: string;
  errorMessage?: string;
}

/**
 * Shim over `runOneShotAgent` - tests replace this with a mock
 * that returns scripted `TinyRunResult` values without spawning
 * anything. Production wires through `subagent-spawn.runOneShotAgent`.
 */
export type TinyRunOneShot<M> = (args: {
  cwd: string;
  agent: AgentDef;
  model: M;
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  task: string;
  signal?: AbortSignal;
  onEvent?: (wrapped: { event: CostEventLike }) => void;
  timeoutMs?: number;
}) => Promise<TinyRunResult>;

/**
 * Everything the adapter needs from the pi runtime + environment.
 * The extension wires this up once at startup; tests pass a fully
 * mocked wiring.
 */
export interface TinyAdapterWiring<M> {
  /** Resolved settings. `null` → adapter permanently disabled. */
  settings: TinySettings | null;
  /**
   * Loaded `tiny-helper` agent definition. `null` → adapter
   * permanently disabled (agent not installed).
   */
  tinyHelperAgent: AgentDef | null;
  /** One-shot spawner. Usually `runOneShotAgent` wrapped. */
  runOneShot: TinyRunOneShot<M>;
  /** Optional journal path - stall/error lines are written here. */
  journalPath?: string;
  /** Per-call output length cap. Default 120 chars. */
  maxOutputChars?: number;
}

export interface TinyCallOpts {
  /** Override the per-call output length cap. */
  maxOutputChars?: number;
  /** Override the agent timeout for this call. */
  timeoutMsOverride?: number;
}

/**
 * Adapter surface. All three call methods share the same flow:
 *
 *   a. `isEnabled()` → false → `null`.
 *   b. run-root present + `shouldCall` false → journal warning,
 *      `null`.
 *   c. resolve child model → error → journal info, `null`.
 *   d. build task string.
 *   e. `incrementCallCount` (when counter active).
 *   f. `runOneShot({...})`.
 *   g. take first non-whitespace line, trim.
 *   h. validate (empty / `"null"` / too long / wrong label) → `null`.
 *   i. return string / label / candidate.
 *
 * `getTotalCost()` is advisory - unavailable cost data is tolerated.
 */
export interface TinyAdapter<M = unknown> {
  isEnabled(): boolean;
  callTinyRewrite(ctx: TinyCallContext<M>, task: string, input: string, opts?: TinyCallOpts): Promise<string | null>;
  callTinyClassify(
    ctx: TinyCallContext<M>,
    task: string,
    input: string,
    labels: readonly string[],
    opts?: TinyCallOpts,
  ): Promise<string | null>;
  callTinyMatch(
    ctx: TinyCallContext<M>,
    query: string,
    candidates: readonly string[],
    opts?: TinyCallOpts,
  ): Promise<string | null>;
  /** Cumulative `usage.cost.total` across every call since adapter creation. */
  getTotalCost(): number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 120;

function firstLine(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

function journal(wiring: { journalPath?: string }, level: JournalLevel, heading: string, body?: string): void {
  if (!wiring.journalPath) return;
  try {
    appendJournal(wiring.journalPath, body !== undefined ? { level, heading, body } : { level, heading });
  } catch {
    /* swallow - journal failure never breaks the adapter */
  }
}

function buildRewriteTask(task: string, input: string): string {
  return `Task: ${task}\n\nInput:\n${input}\n\nReply with ONE short line, no punctuation runs, no prose. If you cannot produce a valid answer, reply with the literal string null.`;
}

function buildClassifyTask(task: string, input: string, labels: readonly string[]): string {
  return `Task: ${task}\n\nInput:\n${input}\n\nReply with EXACTLY one of these labels and nothing else:\n${labels.map((l) => `  - ${l}`).join('\n')}\nIf none applies, reply with the literal string null.`;
}

function buildMatchTask(query: string, candidates: readonly string[]): string {
  return `Task: pick the single best match for the query from the candidate list.\n\nQuery: ${query}\n\nCandidates:\n${candidates.map((c) => `  - ${c}`).join('\n')}\n\nReply with EXACTLY one candidate verbatim and nothing else. If none match, reply with the literal string null.`;
}

/**
 * Build a {@link TinyAdapter} from a fully-resolved wiring. Call
 * once at extension startup; reuse the returned object for all
 * research tiny calls in the same process.
 */
export function createTinyAdapter<M>(wiring: TinyAdapterWiring<M>): TinyAdapter<M> {
  const maxOutputDefault = wiring.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  let totalCost = 0;

  const isEnabled = (): boolean => wiring.settings !== null && wiring.tinyHelperAgent !== null;

  const preflight = (ctx: TinyCallContext<M>): { ok: true; agent: AgentDef; model: M } | { ok: false } => {
    const agent = wiring.tinyHelperAgent;
    const settings = wiring.settings;
    if (!agent || !settings) return { ok: false };

    if (ctx.runRoot !== undefined) {
      const max = ctx.maxCalls ?? 0;
      if (!shouldCall(ctx.runRoot, max)) {
        journal(wiring, 'warn', 'tiny-adapter call budget exhausted', `runRoot=${ctx.runRoot} maxCalls=${max}`);
        return { ok: false };
      }
    }

    const resolution = resolveChildModel({
      override: settings.tinyModel,
      agent,
      parent: ctx.model,
      modelRegistry: ctx.modelRegistry,
    });
    if (!resolution.ok) {
      journal(wiring, 'info', 'tiny-adapter model resolution failed', resolution.error);
      return { ok: false };
    }

    // A thinking-level suffix on the tinyModel spec (e.g. `:off`) overrides
    // the agent def's own thinkingLevel for the spawned run.
    const runAgent = agentWithResolvedThinking(agent, resolution.thinkingLevel);

    return { ok: true, agent: runAgent, model: resolution.model };
  };

  const runAndValidate = async (
    ctx: TinyCallContext<M>,
    taskPrompt: string,
    opts: TinyCallOpts | undefined,
    validate: (line: string) => string | null,
  ): Promise<string | null> => {
    const pre = preflight(ctx);
    if (!pre.ok) return null;

    if (ctx.runRoot !== undefined) {
      try {
        incrementCallCount(ctx.runRoot);
      } catch (e) {
        journal(wiring, 'warn', 'tiny-adapter counter write failed', e instanceof Error ? e.message : String(e));
        // continue anyway - the budget check already passed
      }
    }

    const max = opts?.maxOutputChars ?? maxOutputDefault;

    let result: TinyRunResult;
    try {
      result = await wiring.runOneShot({
        cwd: ctx.cwd,
        agent: pre.agent,
        model: pre.model,
        modelRegistry: ctx.modelRegistry,
        task: taskPrompt,
        signal: ctx.signal,
        onEvent: ({ event }) => {
          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            const total = event.message.usage?.cost?.total;
            if (typeof total === 'number' && Number.isFinite(total)) {
              totalCost += total;
            }
          }
        },
        timeoutMs: opts?.timeoutMsOverride,
      });
    } catch (e) {
      journal(wiring, 'info', 'tiny-adapter spawn error', e instanceof Error ? e.message : String(e));
      return null;
    }

    if (result.stopReason !== 'completed') {
      journal(wiring, 'info', `tiny-adapter stop=${result.stopReason}`, result.errorMessage ?? '(no message)');
      return null;
    }

    const line = firstLine(result.finalText);
    if (line.length === 0) return null;
    if (line.length > max) return null;
    if (line === 'null') return null;

    return validate(line);
  };

  return {
    isEnabled,

    async callTinyRewrite(ctx, task, input, opts) {
      return runAndValidate(ctx, buildRewriteTask(task, input), opts, (line) => line);
    },

    async callTinyClassify(ctx, task, input, labels, opts) {
      if (labels.length === 0) return null;
      return runAndValidate(ctx, buildClassifyTask(task, input, labels), opts, (line) => {
        return labels.includes(line) ? line : null;
      });
    },

    async callTinyMatch(ctx, query, candidates, opts) {
      if (candidates.length === 0) return null;
      return runAndValidate(ctx, buildMatchTask(query, candidates), opts, (line) => {
        return candidates.includes(line) ? line : null;
      });
    },

    getTotalCost() {
      return totalCost;
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Convenience helpers
// ───────────────────────────────────────────────────────────────────

/**
 * Best-effort one-liner summary for a research artifact's
 * provenance sidecar. Returns `null` when:
 *
 *   - `adapter` or `ctx` is undefined;
 *   - the adapter is disabled (`isEnabled() === false`);
 *   - the tiny call throws or returns `null` (budget exhausted,
 *     timeout, malformed response, etc.).
 *
 * Consumers pass the returned value straight into
 * `research-provenance.writeSidecar` via the `summary?` field;
 * `null` means "omit the field." The wrapper exists so every
 * `summarize-provenance` call-site uses the same semantics (and
 * the same swallow-errors contract) without re-implementing the
 * dance at every writer.
 *
 * `excerpt` should be a short, context-appropriate string (~400
 * chars or less). Callers compose it from whatever makes the
 * sidecar greppable post-hoc - a task name, a sub-question id,
 * the first line of the prompt. The adapter enforces its own
 * output-length cap (default 120 chars) so a verbose excerpt
 * doesn't leak into the summary.
 */
export async function tinyProvenanceSummary<M>(
  adapter: TinyAdapter<M> | undefined,
  ctx: TinyCallContext<M> | undefined,
  excerpt: string,
): Promise<string | null> {
  if (!adapter || !ctx || !adapter.isEnabled()) return null;
  try {
    const out = await adapter.callTinyRewrite(ctx, 'summarize-provenance', excerpt);
    if (typeof out === 'string' && out.trim().length > 0) return out.trim();
  } catch {
    /* swallow - summary is advisory */
  }
  return null;
}

/**
 * Build the `onRetry` callback that the planner / self-critic /
 * synth stages hand to `callTyped` so a validation error gets
 * rewritten into plain English by the tiny model before it is
 * journaled.
 *
 * Every one of those stages had the identical wrapper: bail to the
 * `passthrough` when the adapter is disabled, otherwise fire the
 * caller's `passthrough` immediately, kick off a best-effort
 * `humanize-error` rewrite, and route a non-empty result into
 * `onHumanized`. Both hooks are best-effort - `callTyped` does not
 * await them and a tiny failure never breaks the retry loop.
 *
 *   - `onHumanized(humanized, attempt)` - called with the friendlier
 *     string (already trimmed, guaranteed non-empty). Stages use it
 *     to journal the nudge.
 *   - `passthrough(error, attempt)` - the caller's own hook. Returned
 *     verbatim when the adapter is disabled so the raw error still
 *     flows through, and invoked before humanization when enabled.
 */
export function buildTinyHumanizeOnRetry<M>(
  adapter: TinyAdapter<M> | undefined,
  ctx: TinyCallContext<M> | undefined,
  onHumanized: (humanized: string, attempt: number) => void,
  passthrough?: (error: string, attempt: number) => void,
): ((error: string, attempt: number) => void) | undefined {
  if (!adapter || !ctx || !adapter.isEnabled()) return passthrough;
  return (error, attempt) => {
    passthrough?.(error, attempt);
    void adapter
      .callTinyRewrite(ctx, 'humanize-error', error)
      .then((humanized) => {
        if (typeof humanized === 'string' && humanized.trim().length > 0) {
          onHumanized(humanized.trim(), attempt);
        }
      })
      .catch(() => {
        /* swallow - humanization is advisory */
      });
  };
}
