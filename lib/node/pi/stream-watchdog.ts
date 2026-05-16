/**
 * Pure state-machine helpers for the stream-watchdog extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime. The extension in
 * `config/pi/extensions/stream-watchdog.ts` wires these against pi's
 * `message_start` / `message_update` / `message_end` hooks and a
 * periodic poll.
 *
 * The watchdog cares about ONE thing: the assistant response stream. If
 * an assistant message is mid-stream and no `message_update` has arrived
 * for a configured threshold, the stream is considered stalled. The
 * typical cause is a local inference server (llama.cpp, Ollama) whose
 * HTTP connection is still open but the generation thread has stopped
 * producing tokens - thinking models on modest hardware are the common
 * trigger.
 *
 * Scope choices, explicitly:
 *
 *   - We do NOT watch tool execution. Long-running bash suites,
 *     research subagents, and network-bound tools legitimately run for
 *     minutes-to-hours without emitting partial output, so any tool
 *     watchdog would either cry wolf or need per-tool thresholds that
 *     are impossible to get right. Pi's tool phase and assistant-stream
 *     phase don't overlap in the event model, so watching only the
 *     stream is sufficient to catch "pi is hung waiting on the model"
 *     regardless of how long the preceding tool took.
 *   - We do NOT double-notify. Once a stream has been flagged stale,
 *     the next call to `detectStale` returns `null` until the stream
 *     ends (or is cleared). One notify per stuck stream is enough; the
 *     extension layer decides whether to also abort.
 *   - We do NOT retain history across streams. There's at most one
 *     assistant stream in flight at any time - pi doesn't pipeline
 *     multiple concurrently - so a single-slot state is both correct
 *     and trivially testable.
 */

/**
 * Per-stream bookkeeping. `notified` is the one-shot latch that stops
 * repeat notifications once we've already flagged this stream.
 */
export interface StreamEntry {
  /** Optional opaque id or label (e.g. responseId) surfaced in UI messages. */
  id?: string;
  /** ms timestamp when `message_start` fired. */
  startedAt: number;
  /** ms timestamp of the most recent activity (start or update). */
  lastHeartbeat: number;
  /** True after `detectStale` has fired for this entry. */
  notified: boolean;
}

/**
 * Single-slot state. `current` is `null` whenever no assistant message
 * is being streamed (i.e., between `message_end` and the next
 * `message_start`).
 *
 * Tool-call awareness:
 *   - `inFlightTools` is incremented on every `tool_call` event and
 *     decremented (clamped at 0) on every `tool_result`. While > 0,
 *     the soft silent-stream branch of `detectStale` is suppressed -
 *     a long-running subagent / bash / bg_bash dispatch legitimately
 *     produces zero `message_update` events between call and result.
 *   - `inFlightToolNames` is a parallel stack of tool names so the
 *     status badge / hard-cap warning can surface which tool is
 *     currently blocking forward progress. Top of stack is the most
 *     recent in-flight tool.
 *   - `lastForwardProgress` tracks the most recent forward-progress
 *     event of ANY kind - a stream heartbeat OR a tool lifecycle
 *     event. Drives the hard wall-clock cap, which fires regardless
 *     of in-flight tools so a genuinely-runaway tool can't suppress
 *     the watchdog forever.
 */
export interface StreamWatchdogState {
  current: StreamEntry | null;
  /** Count of in-flight tool calls (≥ 0). Suppresses the soft branch when > 0. */
  inFlightTools: number;
  /** Stack of in-flight tool names; last element is the most recently started. */
  inFlightToolNames: string[];
  /** ms timestamp of the last heartbeat OR tool lifecycle event. Drives the hard cap. */
  lastForwardProgress: number;
}

/** Fresh empty state. Callers hold one instance per extension lifetime. */
export function createState(): StreamWatchdogState {
  return { current: null, inFlightTools: 0, inFlightToolNames: [], lastForwardProgress: 0 };
}

/**
 * Record the start of an assistant stream. Resets any prior entry - if
 * a previous stream somehow never got an `end` event (reload mid-turn,
 * provider reconnect), replacing it is the right move: the new stream
 * is the one we care about now.
 */
export function recordStart(state: StreamWatchdogState, nowMs: number, id?: string): void {
  state.current = { id, startedAt: nowMs, lastHeartbeat: nowMs, notified: false };
  state.lastForwardProgress = nowMs;
}

/**
 * Record a stream heartbeat (token delta, thinking delta, any partial
 * update). Bumps `lastHeartbeat` and clears the `notified` latch so a
 * stream that went silent, notified, and then recovered can be flagged
 * again if it silently stalls a second time. No-op if no stream is in
 * flight - late updates after `message_end` are ignored.
 */
export function recordHeartbeat(state: StreamWatchdogState, nowMs: number): void {
  if (!state.current) return;
  state.current.lastHeartbeat = nowMs;
  state.current.notified = false;
  state.lastForwardProgress = nowMs;
}

/**
 * Record the start of a tool call. Bumps the in-flight counter, pushes
 * the tool name onto the stack, and updates `lastForwardProgress` so
 * the hard cap restarts its clock from "tool just started" rather than
 * from the last token streamed before the model dispatched. Caller is
 * responsible for the `state.current` guard - tool events outside of
 * an active stream should not be tracked.
 */
export function recordToolCall(state: StreamWatchdogState, nowMs: number, toolName: string): void {
  state.inFlightTools += 1;
  state.inFlightToolNames.push(toolName);
  state.lastForwardProgress = nowMs;
}

/**
 * Record the end of a tool call. Decrements the in-flight counter
 * (clamped at 0 - a stray `tool_result` without a matching `tool_call`
 * is a no-op rather than an error), pops the most recent name (if
 * any), and updates `lastForwardProgress`.
 */
export function recordToolResult(state: StreamWatchdogState, nowMs: number): void {
  if (state.inFlightTools > 0) state.inFlightTools -= 1;
  if (state.inFlightToolNames.length > 0) state.inFlightToolNames.pop();
  state.lastForwardProgress = nowMs;
}

/**
 * Defensive reset of the in-flight tool tracking. Called at turn
 * boundaries (`agent_end`) so that a dropped `tool_result` event
 * (provider error, malformed payload) can't permanently suppress the
 * soft watchdog. Does NOT touch `state.current` or
 * `lastForwardProgress` - only the tool counters.
 */
export function resetInFlightTools(state: StreamWatchdogState): void {
  state.inFlightTools = 0;
  state.inFlightToolNames = [];
}

/** Record the end of the assistant stream. Clears the slot. */
export function recordEnd(state: StreamWatchdogState): void {
  state.current = null;
}

/**
 * Reset all state (used on session_start / session_shutdown / real user
 * input). Same as `recordEnd` today but kept as a separate name for
 * readability at the call site.
 */
export function clear(state: StreamWatchdogState): void {
  state.current = null;
  state.inFlightTools = 0;
  state.inFlightToolNames = [];
  state.lastForwardProgress = 0;
}

/**
 * Result returned by {@link detectStale} when a stream has gone stale.
 *
 * - `reason: 'soft'` - the model's stream went silent past `softStallMs`
 *   AND no tool call was in flight. This is the classic "model is
 *   hung mid-generation" signal.
 * - `reason: 'hard'` - `hardStallMs` has elapsed since the last
 *   forward-progress event of ANY kind (heartbeat OR tool event).
 *   Fires regardless of in-flight tools and is the operator brake
 *   against a runaway long tool dispatch.
 *
 * `inFlightTool` is the most-recent in-flight tool name when the
 * result is `'hard'` and a tool was running. `undefined` otherwise.
 */
export interface StaleResult {
  reason: 'soft' | 'hard';
  /** ms since `lastHeartbeat`. Reported for both soft and hard for UI symmetry. */
  silentMs: number;
  startedAt: number;
  lastHeartbeat: number;
  inFlightTool: string | undefined;
}

/**
 * Detect whether the current stream is stalled. Returns `null` when no
 * stream is in flight, when the latch has already fired for this
 * stream, or when neither threshold has elapsed.
 *
 * Two thresholds, separately tunable:
 *
 *   - `softStallMs` - silence on the assistant stream. ONLY checked
 *     when no tool calls are in flight; while a tool is running the
 *     stream is legitimately silent and we don't want to abort.
 *   - `hardStallMs` - wall-clock since the last forward-progress
 *     event of any kind. ALWAYS checked. The brake against a runaway
 *     tool that ignores its own per-tool timeout.
 *
 * When BOTH conditions would fire (no in-flight tool + both elapsed),
 * the soft branch wins - it's the more specific signal ("the model is
 * hung" rather than "some forward progress event happened too long
 * ago"). Documented here because the precedence isn't obvious from
 * the threshold values alone.
 *
 * Marks the current entry `notified = true` as a side effect on either
 * branch so the next poll doesn't re-fire on the same stream until a
 * heartbeat clears the latch.
 */
export function detectStale(
  state: StreamWatchdogState,
  nowMs: number,
  softStallMs: number,
  // Optional so existing 3-arg callers keep working until Phase 1 wires
  // the new threshold through the extension shell. Number.MAX_SAFE_INTEGER
  // means the hard branch never fires - same as having no hard cap at all.
  hardStallMs: number = Number.MAX_SAFE_INTEGER,
): StaleResult | null {
  const cur = state.current;
  if (!cur) return null;
  if (cur.notified) return null;

  const silentMs = nowMs - cur.lastHeartbeat;
  const forwardSilentMs = nowMs - state.lastForwardProgress;
  const softFired = state.inFlightTools === 0 && silentMs >= softStallMs;
  const hardFired = forwardSilentMs >= hardStallMs;

  // Soft wins when both branches fire - see JSDoc.
  if (softFired) {
    cur.notified = true;
    return {
      reason: 'soft',
      silentMs,
      startedAt: cur.startedAt,
      lastHeartbeat: cur.lastHeartbeat,
      inFlightTool: undefined,
    };
  }
  if (hardFired) {
    cur.notified = true;
    const stack = state.inFlightToolNames;
    const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
    return {
      reason: 'hard',
      silentMs,
      startedAt: cur.startedAt,
      lastHeartbeat: cur.lastHeartbeat,
      inFlightTool: top,
    };
  }
  return null;
}

/**
 * Peek at the current entry without mutating state. Useful for tests
 * and for the extension's verbose-mode status rendering.
 */
export function peek(state: StreamWatchdogState): StreamEntry | null {
  return state.current;
}

// ──────────────────────────────────────────────────────────────────────
// Follow-up nudge (mirrors `stall-detect.ts`'s `STALL_MARKER` + builder).
//
// When the watchdog aborts a silent stream, the provider finalises the
// assistant message with `stopReason === 'aborted'` - which
// `stall-recovery.ts` explicitly skips (it can't tell a user-initiated
// Esc apart from a watchdog-initiated cancel). So the watchdog owns its
// own follow-up path: after aborting, it injects a user-role nudge via
// `pi.sendUserMessage(..., { deliverAs: 'followUp' })` from an
// `agent_end` handler, where `isStreaming === false` and the fresh
// prompt actually runs.
//
// The marker mirrors `STALL_MARKER` so a reload-mid-retry can see our
// sentinel on the last user message and avoid double-firing, and so
// users can recognise synthetic continuation messages in the
// transcript. Text is kept short and imperative because the context
// window is already bloated by the stalled reasoning chain that
// triggered us.
// ──────────────────────────────────────────────────────────────────────

/** Sentinel prefix attached to every watchdog-synthesised nudge. */
export const WATCHDOG_MARKER = '⟳ [pi-stream-watchdog]';

/**
 * Detect whether `text` already carries our sentinel. Mirrors
 * `hasStallMarker` in `stall-detect.ts` so callers can ignore our own
 * synthesised nudges when classifying input.
 */
export function hasWatchdogMarker(text: string): boolean {
  return text.includes(WATCHDOG_MARKER);
}

/**
 * Input for {@link buildWatchdogNudge}. `silentSec` and `elapsedSec`
 * are rounded whole seconds (caller is responsible for conversion from
 * ms) so the rendered message is deterministic under vitest.
 */
export interface WatchdogNudgeInput {
  /** Seconds since the last `message_update` when we fired. */
  silentSec: number;
  /** Seconds since `message_start` when we fired (for context only). */
  elapsedSec: number;
  /** 1-indexed attempt number (first retry = 1). */
  attempt: number;
  /** Hard cap - once `attempt === maxAttempts`, this IS the final try. */
  maxAttempts: number;
}

/**
 * Build the follow-up user message the watchdog injects after aborting
 * a stalled stream. Keeps the wording short and action-oriented:
 *
 *   - Explains WHY we aborted (so the model doesn't think the user
 *     changed their mind) - timings come from the live poll state.
 *   - Tells the model to resume the same task (the transcript up to
 *     the abort is intact on the next turn; we want continuation,
 *     not a restart).
 *   - On the final attempt, tightens the language so the model
 *     produces a concrete tool call or a text answer instead of
 *     diving back into an extended-thinking tail.
 *
 * Mirrors `buildRetryMessage` in `stall-detect.ts` for consistency with
 * the companion stall-recovery extension's nudges.
 */
export function buildWatchdogNudge(input: WatchdogNudgeInput): string {
  const { silentSec, elapsedSec, attempt, maxAttempts } = input;
  const budget = `(${attempt}/${maxAttempts})`;
  const isFinalAttempt = attempt >= maxAttempts;
  if (isFinalAttempt) {
    return [
      WATCHDOG_MARKER,
      budget,
      `Your previous turn's stream went silent for ${silentSec}s (${elapsedSec}s total) and was aborted.`,
      `This is the final auto-retry - emit a concrete tool call or a short text answer THIS turn.`,
      'Do NOT spend the whole turn in extended thinking; a silent response will be aborted again.',
      'If genuinely stuck, say so in one sentence (e.g. "Blocked on: <reason>") rather than going silent.',
    ].join(' ');
  }
  return [
    WATCHDOG_MARKER,
    budget,
    `Your previous turn's stream went silent for ${silentSec}s (${elapsedSec}s total) and was aborted.`,
    'Continue where you left off - review any active todos, recheck the last tool result if there was one,',
    'and produce either the next tool call or the final answer. Keep thinking brief.',
  ].join(' ');
}
