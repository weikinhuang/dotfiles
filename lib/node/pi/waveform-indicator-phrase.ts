/**
 * Coalescing reducer + pure helpers for the waveform-indicator's
 * persona-driven `Thinking...` head.
 *
 * Pure module - no pi imports - so it can be unit-tested under
 * `vitest`. The extension shell wires the live tiny-model spawn; this
 * file owns:
 *
 *   - The reducer state shape ({@link WaveformPhraseState}) carrying
 *     the in-flight `AbortController`, monotonic request id, per-turn
 *     dedup `Set`, and per-session call counter.
 *   - {@link issueRequest} / {@link acceptPhrase} - the only two entry
 *     points the extension calls. They encapsulate the stale-id
 *     guard, aborted-in-flight guard, and the abort-previous-on-new
 *     rule.
 *   - {@link resetTurn} - clears `firedThisTurn` so the next turn can
 *     fire its 4 unique-tag spawns again.
 *   - {@link digestPrompt} / {@link digestToolCall} - deterministic
 *     `contextDigest` builders the spawn site hands to the phraser.
 *   - {@link validatePhrase} - guard against multi-line / oversize /
 *     ANSI-smuggling / `null` literal responses.
 *   - {@link buildPhrasePrompt} - assembles the user message handed
 *     to `runOneShotAgent`.
 *   - {@link FALLBACK_PHRASE} - the literal `Thinking...` rendered
 *     while no phrase has been accepted and on every failure path.
 *
 * The fallback contract is "once a phrase is accepted, it stays on
 * screen even while a new spawn is in flight" - never flicker back to
 * the fallback between triggers. The reducer enforces this by leaving
 * `acceptedPhrase` untouched on `issueRequest`; only `acceptPhrase`
 * can overwrite it, and only when the request id and signal agree.
 *
 * The four reset points (new trigger, agent_end, session_shutdown,
 * `/reload`) all reduce to "abort the controller" - the third and
 * fourth are the same code path because pi's `/reload` fires
 * `agent_end` + `session_shutdown` underneath.
 */

import { mergeAbortSignals } from './abort-merge.ts';

/** Fallback head rendered before any phrase lands and on every failure path. */
export const FALLBACK_PHRASE = 'Thinking...';

/**
 * Hard cap on the cleaned phrase length, in user-visible characters.
 * Sized for "a short phrase with a few words" - typically 5-8 words -
 * so small local models (0.5B-1B class) that can't reliably stop at a
 * tighter cap still land a usable phrase. The line still has to fit
 * alongside the dim suffix on a typical 120-col terminal.
 */
export const DEFAULT_MAX_PHRASE_CHARS = 60;

/** First-N characters captured from the user's prompt for the cached `promptDigest`. */
export const PROMPT_DIGEST_CHARS = 200;

/** First-N characters captured from `JSON.stringify(args)` for the tool-call digest. */
export const TOOLCALL_DIGEST_CHARS = 100;

// ──────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────

export interface WaveformPhraseState {
  /**
   * Last validated phrase accepted from a tiny-model spawn. Rendered
   * by the extension's `renderLabel` in place of `Thinking...`.
   * `undefined` while no phrase has ever landed this session - the
   * extension falls back to {@link FALLBACK_PHRASE}.
   */
  acceptedPhrase: string | undefined;
  /**
   * Request id of the most-recently-accepted phrase. Any incoming
   * `acceptPhrase(requestId, ...)` with `requestId < lastAcceptedRequestId`
   * is dropped as stale; `===` is treated as a fresh accept so the
   * very first accept (from id 1, against an initial 0) lands.
   */
  lastAcceptedRequestId: number;
  /** Monotonic id minted by {@link issueRequest}. Starts at 0; first request gets 1. */
  nextRequestId: number;
  /**
   * Controller wired to the in-flight spawn. Replaced (and the previous
   * one `abort()`-ed) on every new {@link issueRequest}. Cleared on
   * `agent_end` / `session_shutdown` / `/reload`.
   */
  controller: AbortController | null;
  /**
   * Cached first-N chars of the most recent user prompt (whitespace
   * collapsed). Captured on `turn_start` and reused by the thinking
   * and text triggers so they don't pay the cost of a session walk
   * every fire.
   */
  promptDigest: string | undefined;
  /**
   * Per-turn dedup set keyed by `phaseTag`. A trigger whose tag is
   * already in this set is a no-op (keep last accepted phrase). The
   * set is cleared on `turn_start` by {@link resetTurn} so the next
   * turn's 4 unique tags can each fire once.
   */
  firedThisTurn: Set<string>;
  /**
   * Per-session call counter. Incremented inside {@link issueRequest}
   * each time a new request id is minted; reset by allocating a
   * fresh state on `session_start`. Once `callsThisSession >=
   * maxCallsPerSession`, the extension short-circuits the trigger
   * before calling {@link issueRequest} so the counter doesn't
   * over-count exhausted-budget no-ops.
   */
  callsThisSession: number;
}

export function newWaveformPhraseState(): WaveformPhraseState {
  return {
    acceptedPhrase: undefined,
    lastAcceptedRequestId: 0,
    nextRequestId: 0,
    controller: null,
    promptDigest: undefined,
    firedThisTurn: new Set<string>(),
    callsThisSession: 0,
  };
}

/**
 * Clear the per-turn dedup set. Called on `turn_start`. Preserves
 * `acceptedPhrase`, `callsThisSession`, and the monotonic id counters
 * - those are session-lifetime, not turn-lifetime.
 */
export function resetTurn(state: WaveformPhraseState): void {
  state.firedThisTurn.clear();
}

/**
 * Mark `phaseTag` as fired this turn and report whether it was already
 * fired. Returns `true` when the trigger has already fired (caller
 * should short-circuit) and `false` when this is the first call for
 * the tag this turn (caller should proceed to spawn).
 *
 * Exposed as a discrete helper so the extension shell can decide to
 * skip the spawn BEFORE minting a request id - otherwise we'd burn
 * the per-session counter on no-ops.
 */
export function markFiredThisTurn(state: WaveformPhraseState, phaseTag: string): boolean {
  if (state.firedThisTurn.has(phaseTag)) return true;
  state.firedThisTurn.add(phaseTag);
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Request issue / accept
// ──────────────────────────────────────────────────────────────────────

export interface IssueRequestResult {
  /** Monotonic id assigned to this spawn. Passed back to {@link acceptPhrase}. */
  requestId: number;
  /**
   * Merged signal: aborts when the new controller fires OR when the
   * parent turn signal does. The spawn site passes this through to
   * `runOneShotAgent` so a parent Ctrl-C tears down the spawn.
   */
  signal: AbortSignal;
}

/**
 * Abort the in-flight controller (if any) and clear it from state.
 * Idempotent - safe to call from any reset point without checking.
 *
 * Called at four reset points: new trigger (via {@link issueRequest}),
 * `agent_end`, `session_shutdown`, and `/reload`. All four route
 * through this helper so the abort semantics are identical.
 */
export function abortInFlight(state: WaveformPhraseState): void {
  if (state.controller) {
    try {
      state.controller.abort();
    } catch {
      /* best-effort - some test mocks throw on double-abort */
    }
    state.controller = null;
  }
}

/**
 * Mint a new request id, abort the previously-stored controller, and
 * compose the new controller's signal with the parent turn signal.
 *
 * The accepted-phrase state is intentionally NOT cleared here - we
 * keep the previous phrase on screen until the new spawn lands a
 * fresh one (or fails, in which case the previous phrase stays).
 */
export function issueRequest(state: WaveformPhraseState, parentSignal: AbortSignal | undefined): IssueRequestResult {
  abortInFlight(state);
  const controller = new AbortController();
  state.controller = controller;
  state.nextRequestId += 1;
  state.callsThisSession += 1;
  const merged = mergeAbortSignals(controller.signal, parentSignal);
  // `mergeAbortSignals` returns `controller.signal` when `parentSignal`
  // is undefined, so the fallback only triggers if both inputs collapse
  // - never in practice.
  return { requestId: state.nextRequestId, signal: merged ?? controller.signal };
}

export type AcceptPhraseResult = 'accepted' | 'stale' | 'cancelled';

/**
 * Attempt to land `phrase` against the given `requestId`. Returns:
 *
 *   - `'accepted'` when the phrase landed and `state.acceptedPhrase`
 *     was updated.
 *   - `'stale'` when `requestId` is older than the most recently
 *     accepted phrase. Caller should drop the response.
 *   - `'cancelled'` when the request's controller has already been
 *     aborted (parent Ctrl-C, new trigger fired, etc.). Caller
 *     should drop the response.
 *
 * The `signal` parameter is the same merged signal the spawn site
 * passes into `runOneShotAgent` so the reducer doesn't have to look
 * up the controller stored in state - the signal IS the controller's
 * view, and abort propagates through `mergeAbortSignals`.
 */
export function acceptPhrase(
  state: WaveformPhraseState,
  requestId: number,
  phrase: string,
  signal: AbortSignal | undefined,
): AcceptPhraseResult {
  if (signal?.aborted === true) return 'cancelled';
  if (requestId < state.lastAcceptedRequestId) return 'stale';
  state.acceptedPhrase = phrase;
  state.lastAcceptedRequestId = requestId;
  return 'accepted';
}

// ──────────────────────────────────────────────────────────────────────
// Digesters
// ──────────────────────────────────────────────────────────────────────

// Match any C0 / DEL control byte. Built via new RegExp so the source
// stays free of embedded control characters (they survive roundtrips but
// trip casual greps and linters).
// oxlint-disable-next-line no-control-regex -- intentional: validator rejects control bytes.
const CONTROL_CHARS_PATTERN = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
// oxlint-disable-next-line no-control-regex -- intentional: validator rejects control bytes.
const CONTROL_CHARS_TESTER = new RegExp('[\\u0000-\\u001f\\u007f]');
// SGR escape introducer: ESC followed by left bracket. A model that
// smuggled a colour code trips this and the response gets dropped.
// oxlint-disable-next-line no-control-regex -- intentional: ANSI escape detection.
const ANSI_SGR_PATTERN = new RegExp('\\u001b\\[');

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[\s.,;:!?-]+$/, '');
}

/**
 * Collapse whitespace, strip control chars, and trim a leading /
 * trailing punctuation tail so the digest reads as a clean sentence
 * fragment. Cap at {@link PROMPT_DIGEST_CHARS} (default 200).
 *
 * Pure + deterministic - specs assert the exact byte output for a
 * canonical input.
 */
export function digestPrompt(text: string, maxChars: number = PROMPT_DIGEST_CHARS): string {
  if (typeof text !== 'string') return '';
  const cleaned = text.replace(CONTROL_CHARS_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return stripTrailingPunctuation(cleaned);
  return stripTrailingPunctuation(cleaned.slice(0, maxChars));
}

/**
 * Build a digest from the tool name + first N chars of stringified
 * arguments. Same cleanup as {@link digestPrompt}. `args` is passed
 * through `JSON.stringify` defensively - some callers hand us already-
 * stringified text, which the digest happily round-trips.
 */
export function digestToolCall(toolName: string, args: unknown, maxArgsChars: number = TOOLCALL_DIGEST_CHARS): string {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  let body = '';
  if (typeof args === 'string') {
    body = args;
  } else if (args !== undefined && args !== null) {
    try {
      body = JSON.stringify(args);
    } catch {
      body = '';
    }
  }
  const cleanedBody = body.replace(CONTROL_CHARS_PATTERN, ' ').replace(/\s+/g, ' ').trim().slice(0, maxArgsChars);
  if (!name && !cleanedBody) return '';
  if (!cleanedBody) return name;
  if (!name) return cleanedBody;
  return `${name} ${cleanedBody}`;
}

// ──────────────────────────────────────────────────────────────────────
// Validator
// ──────────────────────────────────────────────────────────────────────

export interface ValidatePhraseOptions {
  /** Character cap. Defaults to {@link DEFAULT_MAX_PHRASE_CHARS}. */
  maxChars?: number;
}

/**
 * Guard a raw tiny-model response. Returns the cleaned phrase or
 * `null` when the response should be dropped on the floor (caller
 * keeps the previously-accepted phrase).
 *
 * Rejections (return `null`):
 *
 *   - empty / whitespace-only
 *   - multi-line (one phrase, one line)
 *   - contains an ANSI SGR escape (`[`) - model leaked colour
 *   - contains any other control char
 *   - literal `null` (the rule-sheet escape hatch)
 *   - starts with a non-letter (the daemon persona forbids opening
 *     on punctuation; this catches stray bullets or quote marks)
 *
 * Soft handling:
 *
 *   - phrases longer than `opts.maxChars` (default 60 user-visible
 *     chars) are truncated to `maxChars - 1` characters with a
 *     trailing single-character U+2026 ellipsis (`…`) appended.
 *     Rejecting on length would freeze the head on the last
 *     short-enough response; small local models (qwen3-5-0-8b
 *     etc.) are loose about the cap and truncation is friendlier
 *     than dropping.
 */
export function validatePhrase(raw: string, opts: ValidatePhraseOptions = {}): string | null {
  if (typeof raw !== 'string') return null;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_PHRASE_CHARS;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === 'null') return null;
  if (/\r|\n/.test(trimmed)) return null;
  if (ANSI_SGR_PATTERN.test(trimmed)) return null;
  // Build a fresh non-global tester so `lastIndex` state on the shared
  // module-level regex doesn't leak across calls.
  if (CONTROL_CHARS_TESTER.test(trimmed)) return null;
  // Use Array.from to count user-visible characters (handles surrogate
  // pairs - a single emoji is one char, not two code units).
  const chars = Array.from(trimmed);
  const first = chars[0] ?? '';
  if (!/^\p{L}/u.test(first)) return null;
  if (chars.length > maxChars) {
    // Truncate to one less than the cap so the appended ellipsis fits
    // inside the user-visible budget. `stripTrailingPunctuation` keeps
    // us from producing `Verbing the long thing....…` (ASCII dots
    // immediately before the Unicode ellipsis).
    const sliced = chars.slice(0, maxChars - 1).join('');
    return stripTrailingPunctuation(sliced) + '…';
  }
  return trimmed;
}

// ──────────────────────────────────────────────────────────────────────
// Prompt builder
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the user message handed to the `waveform-phraser` agent. The
 * persona overlay is appended to the system prompt at spawn time, so
 * this body stays compact and identical regardless of which persona
 * is active.
 *
 * Format is deliberately spartan: one labelled phase tag, one labelled
 * digest, then the literal `null` escape-hatch reminder. The agent's
 * frontmatter forbids tool use; this prompt reinforces it as a leading
 * sentence in case a persona body softens the rule downstream.
 */
export function buildPhrasePrompt(phaseTag: string, contextDigest: string): string {
  const tag = phaseTag.trim();
  const digest = contextDigest.trim();
  const lines: string[] = [
    'Never call tools, never read files, never run commands. Reply with one short present-participle phrase only.',
    '',
    `phaseTag: ${tag || '(none)'}`,
  ];
  if (digest.length > 0) {
    lines.push(`contextDigest: ${digest}`);
  }
  lines.push('', 'If you cannot produce a valid phrase, reply with the literal string null.');
  return lines.join('\n');
}
