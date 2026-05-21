/**
 * Pure sample-step state machine for the `tokenrate` waveform mode.
 *
 * Drives the conversion from the suffix's running "cumulative output
 * tokens" estimate into a tokens-per-second sample the
 * `pushTokenRateSample` / `tokenRateBarsToHeights` / `buildTokenRateFrame`
 * helpers in `waveform-indicator.ts` then render as braille bars.
 *
 * Why a separate module: the rules are fiddly enough that they deserve
 * their own focused unit tests (negative-delta re-baseline, sub-ms `dt`
 * skip, first-sample-after-message-start skip, post-message-end reset),
 * and the buffer/render helpers live in `waveform-indicator.ts` which
 * already has plenty going on.
 *
 * Lifecycle from the extension shell:
 *   - `agent_start` → `newTokenRateState()`
 *   - assistant `message_update` `start` → `markMessageStart(state, nowMs, currentTokens)`
 *   - label-tick (every 50 ms) → `stepTokenRate(state, currentTokens, nowMs)`;
 *     push the returned `rate` (when defined) onto the render buffer.
 *   - assistant `message_end` → `markMessageEnd(state)`
 *   - `agent_end` / `session_shutdown` → drop the state with the rest of
 *     the per-loop bookkeeping.
 */

/**
 * Minimum `dt` (ms) between two samples before we'll compute a rate. The
 * label ticker fires at 50 ms; this guard catches the edge case where two
 * ticks land in the same millisecond (or `Date.now()` wobbles backward by
 * a sub-ms amount) and would otherwise divide by ~0.
 */
export const MIN_SAMPLE_DT_MS = 1;

export interface TokenRateState {
  /** Wall-clock ms of the previous accepted sample. `undefined` before the first sample. */
  lastSampleAtMs: number | undefined;
  /** Cumulative output-token estimate at `lastSampleAtMs`. `undefined` before the first sample. */
  lastSampleTokens: number | undefined;
  /**
   * When true, the next {@link stepTokenRate} call updates the baseline
   * but emits no rate. Set on `message_start` so the first computed rate
   * aligns to "tokens since text actually started flowing" rather than to
   * the previous idle gap.
   */
  skipNextSample: boolean;
}

export interface TokenRateStep {
  /**
   * `undefined` when the sample was skipped (first-call baselining,
   * sub-ms `dt`, post-`message_start` first sample). Otherwise the
   * tokens-per-second rate to push onto the render buffer. `0` when the
   * step re-baselined off a negative delta (post-`message_end` counter
   * reset or compaction shrinking `committedUsage`).
   */
  rate: number | undefined;
  /** True when a negative delta forced a baseline reset. Surfaces for testability. */
  rebaselined: boolean;
}

export function newTokenRateState(): TokenRateState {
  return {
    lastSampleAtMs: undefined,
    lastSampleTokens: undefined,
    skipNextSample: false,
  };
}

/**
 * Note the start of a fresh assistant message. The next
 * {@link stepTokenRate} call skips emission (its baseline becomes the
 * tokens captured here), so the first rate landing on the chart reflects
 * the post-start delta rather than the cumulative gap since the previous
 * sample.
 */
export function markMessageStart(state: TokenRateState, nowMs: number, currentTokens: number): void {
  state.lastSampleAtMs = nowMs;
  state.lastSampleTokens = currentTokens;
  state.skipNextSample = true;
}

/**
 * Clear the baseline after `message_end`. The next time {@link stepTokenRate}
 * is called it will re-baseline as if the rate machine just started, so
 * the next message starts clean instead of carrying a stale anchor
 * forward.
 */
export function markMessageEnd(state: TokenRateState): void {
  state.lastSampleAtMs = undefined;
  state.lastSampleTokens = undefined;
  state.skipNextSample = false;
}

/**
 * Advance the rate machine with a fresh `(currentTokens, nowMs)` sample.
 *
 * Rules, in order of evaluation:
 *   1. **First sample / cold start** - no previous baseline, capture it and emit nothing.
 *   2. **`dt < {@link MIN_SAMPLE_DT_MS}`** - skip without touching the baseline.
 *      Prevents divide-by-zero and noise spikes when two ticks share a millisecond.
 *   3. **`delta < 0`** - re-baseline and emit `rate = 0`. Triggers on the
 *      post-`message_end` byte-counter reset and on pi compaction shrinking
 *      `committedUsage` mid-turn. Without the re-baseline the buffer would
 *      stay stuck at zero until the cumulative count caught up to the
 *      pre-shrink snapshot, which could be tens of seconds.
 *   4. **`skipNextSample`** - consume the flag, update the baseline, emit nothing.
 *      Aligns the first post-`message_start` rate to actual token flow.
 *   5. **Normal** - compute `delta / dt` (tokens/sec), update the baseline, emit the rate.
 */
export function stepTokenRate(state: TokenRateState, currentTokens: number, nowMs: number): TokenRateStep {
  if (state.lastSampleAtMs === undefined || state.lastSampleTokens === undefined) {
    state.lastSampleAtMs = nowMs;
    state.lastSampleTokens = currentTokens;
    return { rate: undefined, rebaselined: false };
  }
  const dtMs = nowMs - state.lastSampleAtMs;
  if (dtMs < MIN_SAMPLE_DT_MS) {
    return { rate: undefined, rebaselined: false };
  }
  const delta = currentTokens - state.lastSampleTokens;
  if (delta < 0) {
    state.lastSampleAtMs = nowMs;
    state.lastSampleTokens = currentTokens;
    // Consume any pending skip too - the re-baseline already aligned us.
    state.skipNextSample = false;
    return { rate: 0, rebaselined: true };
  }
  if (state.skipNextSample) {
    state.skipNextSample = false;
    state.lastSampleAtMs = nowMs;
    state.lastSampleTokens = currentTokens;
    return { rate: undefined, rebaselined: false };
  }
  const dt = dtMs / 1000;
  const rate = delta / dt;
  state.lastSampleAtMs = nowMs;
  state.lastSampleTokens = currentTokens;
  return { rate, rebaselined: false };
}
