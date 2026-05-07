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
 * producing tokens — thinking models on modest hardware are the common
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
 *     assistant stream in flight at any time — pi doesn't pipeline
 *     multiple concurrently — so a single-slot state is both correct
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
 */
export interface StreamWatchdogState {
  current: StreamEntry | null;
}

/** Fresh empty state. Callers hold one instance per extension lifetime. */
export function createState(): StreamWatchdogState {
  return { current: null };
}

/**
 * Record the start of an assistant stream. Resets any prior entry — if
 * a previous stream somehow never got an `end` event (reload mid-turn,
 * provider reconnect), replacing it is the right move: the new stream
 * is the one we care about now.
 */
export function recordStart(state: StreamWatchdogState, nowMs: number, id?: string): void {
  state.current = { id, startedAt: nowMs, lastHeartbeat: nowMs, notified: false };
}

/**
 * Record a stream heartbeat (token delta, thinking delta, any partial
 * update). Bumps `lastHeartbeat` and clears the `notified` latch so a
 * stream that went silent, notified, and then recovered can be flagged
 * again if it silently stalls a second time. No-op if no stream is in
 * flight — late updates after `message_end` are ignored.
 */
export function recordHeartbeat(state: StreamWatchdogState, nowMs: number): void {
  if (!state.current) return;
  state.current.lastHeartbeat = nowMs;
  state.current.notified = false;
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
}

/**
 * Return the current entry if it has been stalled for `>= stallMs`
 * since its last heartbeat and we haven't yet notified for it. Marks
 * the entry `notified = true` as a side effect so the next poll doesn't
 * re-fire on the same stream. Returns `null` otherwise.
 *
 * Caller uses the return value to decide whether to surface a UI
 * warning and/or abort the agent operation.
 */
export function detectStale(state: StreamWatchdogState, nowMs: number, stallMs: number): StreamEntry | null {
  const cur = state.current;
  if (!cur) return null;
  if (cur.notified) return null;
  if (nowMs - cur.lastHeartbeat < stallMs) return null;
  cur.notified = true;
  return cur;
}

/**
 * Peek at the current entry without mutating state. Useful for tests
 * and for the extension's verbose-mode status rendering.
 */
export function peek(state: StreamWatchdogState): StreamEntry | null {
  return state.current;
}
