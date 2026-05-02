/**
 * Typed-LLM-output wrapper with retry + fallback + escape-hatch
 * recognition — the load-bearing reliability primitive the research
 * toolkit uses anywhere a downstream step needs a structured value
 * from an LLM turn (plan.json fields, critic verdicts, experiment
 * summaries, synthesis placeholders).
 *
 * Flow per call:
 *
 *   1. Drive one `session.prompt(opts.prompt)` turn.
 *   2. Extract the trailing assistant text.
 *   3. `parseTolerant` it: strip ```json fences (single-line and
 *      multi-line), unwrap qwen3-style nested fences, slice out the
 *      first balanced `{...}` even when the model emits trailing
 *      prose. Returns `unknown | null`.
 *   4. If the parsed value structurally matches a {@link Stuck}
 *      shape, return it verbatim — the caller's contract is that
 *      `callTyped<T>` may hand back the escape-hatch. Stuck is NOT
 *      re-validated against the caller's schema: it's a first-class
 *      response shape, not a malformed `T`.
 *   5. Otherwise run the caller's validator. On `ok`, return the
 *      validated value. On `!ok`, count the attempt as malformed:
 *      invoke `onRetry(err, attempt)`, then send a one-turn nudge
 *      back to the SAME session:
 *
 *          "your previous response failed validation: <err>.
 *          Re-emit matching the exact schema."
 *
 *      and go back to step 2.
 *   6. After `maxRetries` failed attempts (default 3), call
 *      `fallback()` and return that.
 *
 * The module lives in the pi-runtime-aware half of the research
 * toolkit (it expects an `AgentSession`-shaped object). But it
 * does not import from `@mariozechner/pi-coding-agent` — the
 * session + message shapes are structural, matching the precedent
 * in `subagent-spawn.ts` / `subagent-result.ts`. Tests plug in a
 * mock session without a live pi runtime.
 *
 * Validation error strings are produced by the caller's
 * `SchemaLike<T>.validate` — we do not impose a specific schema
 * library (TypeBox, zod, hand-rolled) so callers can pick whatever
 * matches their data shape. The `Stuck` escape-hatch check is
 * structural, independent of the caller's schema.
 *
 * Note on duplication: the fence-stripping + balanced-`{}` slicing
 * logic here overlaps with `iteration-loop-check-critic.parseVerdict`.
 * They were kept separate on purpose — the critic tracks a
 * `recoveries: string[]` trail and synthesizes a failure Verdict,
 * while this module returns `unknown | null` and lets the retry
 * loop decide what "malformed" means. If a third consumer appears,
 * extract the two primitives (`stripAllFences`, `sliceFirstJsonObject`)
 * into a shared helper; with only two consumers the inlining is
 * cheaper than a cross-module abstraction.
 */

import { isStuckShape, type Stuck } from './research-stuck.ts';
import { extractFinalAssistantText, type AgentMessageLike } from './subagent-result.ts';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal structural shape of pi's `AgentSession` that `callTyped`
 * needs. We take `prompt` (drive one turn) and `state.messages`
 * (read the assistant reply). `subscribe` / `abort` / `dispose`
 * are the caller's responsibility.
 */
export interface ResearchSessionLike {
  prompt(task: string): Promise<void>;
  readonly state: { messages: readonly unknown[] };
}

/** Result shape returned by a caller-supplied validator. */
export type SchemaResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Caller-supplied validator. Accepts a parsed JSON-ish value and
 * either produces a typed output or a human-readable error message
 * the nudge prompt can echo back to the model. Validator authors
 * choose how deeply they want to check — a single `typeof` check
 * for the happy path, or a full schema walk with precise error
 * paths. The error string is fed verbatim into the retry nudge.
 */
export interface SchemaLike<T> {
  validate(v: unknown): SchemaResult<T>;
}

/**
 * Options accepted by `callTyped`.
 *
 * `fallback` is required: the Phase 5 failure-mode suite asserts
 * that a `callTyped` exhausting retries with no fallback configured
 * throws a typed error rather than returning `undefined`. We satisfy
 * that contract by making the fallback mandatory — callers who want
 * throw-on-exhaust wire `fallback: () => { throw ... }`.
 */
export interface CallTypedOpts<T> {
  /** Live session to drive. Same session is reused across retries. */
  session: ResearchSessionLike;
  /** Initial user-turn prompt. Sent once; nudges are sent afterward. */
  prompt: string;
  /** Validator that decides what a valid `T` looks like. */
  schema: SchemaLike<T>;
  /** Hard cap on attempts (first attempt + retries). Default 3. */
  maxRetries?: number;
  /** Last-resort producer of a `T` when retries exhaust. Required. */
  fallback: () => T;
  /**
   * Observability hook called BEFORE each retry nudge is sent — i.e.
   * after each malformed attempt. `attempt` is the 1-indexed number
   * of the attempt that just failed.
   */
  onRetry?: (error: string, attempt: number) => void;
  /**
   * Extract the trailing assistant text. Defaults to
   * `extractFinalAssistantText`. Override only when the session
   * stores messages in a non-standard shape (e.g. a test fake).
   */
  extractText?: (messages: readonly unknown[]) => string;
}

// ──────────────────────────────────────────────────────────────────────
// Tolerant parser
// ──────────────────────────────────────────────────────────────────────

/**
 * Strip *all* leading + trailing triple-backtick fences from `raw`.
 *
 * Real-world cases we absorb:
 *   - `"```json\n{...}\n```"` (the common case, any tag or none).
 *   - `"```JSON {...} ```"` (single-line fence — whitespace-only
 *     content between the fences).
 *   - `"```json\n```json\n{...}\n```\n```"` (qwen3 "double wrap" —
 *     a fenced block whose body is itself a fenced block; observed
 *     in the iteration-loop Phase 6 smoke findings).
 *
 * The loop is bounded (`safetyLimit`) so pathological input can't
 * spin forever. Each iteration must remove content; when nothing
 * changes we stop.
 */
function stripAllFences(raw: string): string {
  const openRe = /^```[a-zA-Z0-9]*\s*(?:\n|(?=[^\n]))/;
  const closeRe = /\s*```\s*$/;
  let cur = raw.trim();
  for (let i = 0; i < 8; i++) {
    const before = cur;
    const openMatch = openRe.exec(cur);
    if (openMatch) cur = cur.slice(openMatch[0].length).trim();
    if (closeRe.test(cur)) cur = cur.replace(closeRe, '').trim();
    if (cur === before) break;
  }
  return cur;
}

/**
 * Slice out the first balanced `{...}` JSON object starting at the
 * first `{` in `text`. Tracks string literals (with escape support)
 * and nested braces. Returns `null` when no balanced object exists
 * (unbalanced, empty, or no `{` at all).
 */
function sliceFirstJsonObject(text: string): string | null {
  const firstBrace = text.indexOf('{');
  if (firstBrace < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(firstBrace, i + 1);
    }
  }
  return null;
}

/**
 * Public-facing tolerant parser. Accepts an LLM's raw text output
 * and returns either a parsed JSON-ish value or `null` when no
 * recognizable JSON object could be extracted. `null` signals
 * "malformed — bump the retry counter." `callTyped` is the primary
 * consumer; we export the helper for modules that need the same
 * leniency without the retry loop (e.g. one-shot readers).
 *
 * Policy:
 *   - Trim, strip fences (including qwen3 double-wrap), then try
 *     `JSON.parse` on the full stripped text.
 *   - On failure, slice the first balanced `{...}` and `JSON.parse`
 *     that.
 *   - On failure, return `null`. We deliberately do not try to
 *     repair (e.g. add missing commas) — a parser that repairs
 *     silently ends up returning shapes the caller's validator
 *     cannot catch.
 */
export function parseTolerant(raw: string): unknown {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return null;
  const stripped = stripAllFences(trimmed);
  if (stripped.length === 0) return null;
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through to the slicing strategy
  }
  const sliced = sliceFirstJsonObject(stripped);
  if (sliced === null) return null;
  try {
    return JSON.parse(sliced);
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// callTyped
// ──────────────────────────────────────────────────────────────────────

/**
 * Render the one-turn retry nudge. Separated so tests can assert the
 * exact wording — the failure-mode suite checks that the error
 * string is echoed back to the model (otherwise weak models repeat
 * the same mistake).
 */
export function renderValidationNudge(error: string): string {
  return `your previous response failed validation: ${error}. Re-emit matching the exact schema.`;
}

/**
 * Drive the validation retry loop described in the module header.
 * Returns `T` on success, `Stuck` when the model emits the escape
 * hatch, or `fallback()` after `maxRetries` malformed attempts.
 *
 * The session is reused across retries — this is what makes the
 * nudge effective: the model sees its own earlier response in
 * context when re-emitting.
 */
export async function callTyped<T>(opts: CallTypedOpts<T>): Promise<T | Stuck> {
  const maxRetries = Math.max(1, opts.maxRetries ?? 3);
  const extract =
    opts.extractText ?? ((m: readonly unknown[]) => extractFinalAssistantText(m as readonly AgentMessageLike[]));

  let lastError = 'unknown validation error';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const nextPrompt = attempt === 1 ? opts.prompt : renderValidationNudge(lastError);
    await opts.session.prompt(nextPrompt);

    const raw = extract(opts.session.state.messages);
    const parsed = parseTolerant(raw);

    // Stuck is recognized BEFORE the caller's validator runs — it's
    // a first-class response, not a malformed `T`. An invalid stuck
    // shape (missing/empty `reason`, wrong discriminator, etc.)
    // falls through to the validator and is counted as malformed.
    if (parsed !== null && isStuckShape(parsed)) {
      return parsed;
    }

    let err: string;
    if (parsed === null) {
      err = 'response is not parseable JSON';
    } else {
      const result = opts.schema.validate(parsed);
      if (result.ok) return result.value;
      err = result.error;
    }

    lastError = err;
    opts.onRetry?.(err, attempt);
  }

  return opts.fallback();
}
