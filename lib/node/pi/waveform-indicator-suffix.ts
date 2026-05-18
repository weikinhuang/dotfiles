/**
 * Pure helpers for the dim claude-code-style suffix on the waveform
 * indicator's `Thinking...` label. Produces strings like:
 *
 *   (5s)
 *   (5s · ↑ 185 tokens)
 *   (22s · ↓ 759 tokens · still thinking with medium effort)
 *   (53s · ↓ 2.5k tokens · thought for 2s)
 *
 * The shimmering label itself lives in `waveform-indicator.ts`. This
 * module only formats the trailing parens and wraps them in a dim SGR.
 *
 * The state machine the formatter renders is driven by the extension
 * shell (which sees pi's `message_update` stream events) and is
 * intentionally serialisable so vitest can drive every transition with
 * plain object literals - no fake-timer / fake-streaming-provider setup.
 */

const DIM_OPEN = '\x1b[2;38;5;245m';
const DIM_CLOSE = '\x1b[0m';

// Chosen to match pi-ai's `ThinkingLevel`. Declared locally so this module
// stays under the lib/AGENTS.md "no @earendil-works imports" rule. Kept in
// lockstep with `packages/agent/src/types.ts` in the pi repo - currently
// `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`.
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * "still thinking" kicks in this many ms into the *current* thinking
 * block (the timer restarts when a new block starts).
 */
export const STILL_THINKING_THRESHOLD_MS = 20_000;

/**
 * Per-turn-loop bookkeeping that drives the suffix.
 *
 * Reset on `agent_start`. All token / thinking bookkeeping resets per
 * `turn_start` so the displayed counters reflect the current turn only,
 * matching claude-code's per-turn semantics. Loop start time and the
 * `getContextUsage()`-driven ↑ floor are session-level and grow
 * naturally across turns through pi's own context tracking.
 */
export interface LabelSuffixState {
  /** Wall-clock at which the agent loop started, ms-since-epoch. Drives `formatElapsed`. */
  loopStartedAtMs: number;
  /**
   * Phase of the current turn:
   *   - 'uplink'  : we've sent context up and are waiting for the model
   *                 to respond. Token segment shows `↑ <input>`.
   *   - 'downlink': the model has begun streaming back (text, thinking,
   *                 or tool calls). Token segment shows `↓ <output>`.
   */
  phase: 'uplink' | 'downlink';
  /**
   * Input/output tokens committed by the most recent assistant
   * message_end this turn. Reset to zero on each `turn_start` so the
   * displayed counter is per-turn rather than session-cumulative.
   */
  committedUsage: { input: number; output: number };
  /**
   * Latest `partial.usage` from the in-flight assistant message, or
   * undefined when no message is streaming. Many providers leave this
   * at zero until the final chunk - see `currentMessageOutputBytes` for
   * the streaming-side fallback.
   */
  currentUsage: { input: number; output: number } | undefined;
  /**
   * Accumulated byte length of `text_delta` + `thinking_delta` events
   * in the in-flight message. Reset on each new message `start`. Used
   * as a streaming-output token estimate (bytes / 4) when the provider
   * doesn't populate `partial.usage.output` mid-stream - so the ↓
   * counter still ticks up live for providers like OpenAI Responses
   * that only emit usage in the final chunk.
   */
  currentMessageOutputBytes: number;
  /** Per-turn thinking bookkeeping. Reset on `turn_start`. */
  thinking: {
    /** Cumulative ms across all thinking blocks completed this turn. */
    cumulativeMs: number;
    /**
     * Wall-clock at which the active thinking block started, or
     * undefined when the model isn't currently thinking.
     */
    activeStartedAtMs: number | undefined;
    /** True if any thinking block has ended this turn. Drives `thought for Ns`. */
    hasFinishedAny: boolean;
    /**
     * True once the model has begun streaming non-thinking output
     * (text or tool calls) this turn. Suppresses the thinking segment
     * once we've moved into the answer phase: `thought for Ns` only
     * shows in the brief window between `thinking_end` and the first
     * `text_start` / `toolcall_start`. A *new* `thinking_start` after
     * that (interleaved thinking) reopens the live segment via
     * `activeStartedAtMs` taking precedence.
     */
    hasStreamedNonThinkingContent: boolean;
  };
}

/** Build a fresh state for a new agent loop. */
export function newLabelSuffixState(nowMs: number): LabelSuffixState {
  return {
    loopStartedAtMs: nowMs,
    phase: 'uplink',
    committedUsage: { input: 0, output: 0 },
    currentUsage: undefined,
    currentMessageOutputBytes: 0,
    thinking: {
      cumulativeMs: 0,
      activeStartedAtMs: undefined,
      hasFinishedAny: false,
      hasStreamedNonThinkingContent: false,
    },
  };
}

/** Reset turn-level fields without losing the loop start time. */
export function resetTurnState(state: LabelSuffixState): void {
  state.phase = 'uplink';
  state.committedUsage = { input: 0, output: 0 };
  state.currentUsage = undefined;
  state.currentMessageOutputBytes = 0;
  state.thinking = {
    cumulativeMs: 0,
    activeStartedAtMs: undefined,
    hasFinishedAny: false,
    hasStreamedNonThinkingContent: false,
  };
}

/**
 * Roughly four UTF-8 bytes per token for English-ish prose - close
 * enough for a live indicator that snaps to the provider's real number
 * once `message_end` arrives.
 */
const BYTES_PER_TOKEN = 4;

// ──────────────────────────────────────────────────────────────────────
// Formatters
// ──────────────────────────────────────────────────────────────────────

/**
 * Render an elapsed duration as `5s`, `42s`, `1m 18s`, `2h 3m`. Negative
 * and non-finite inputs collapse to `0s` rather than throwing.
 *
 * Rounding floors to whole seconds so the displayed counter ticks up
 * monotonically (1, 2, 3, ...) instead of jumping around at sub-second
 * boundaries.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/**
 * Render a token count claude-code-style: raw integer below 1000,
 * `N.Nk` from 1000 to 999999, `N.NM` above. Always one decimal in the
 * `k`/`M` ranges (claude shows `2.0k`, not `2k`).
 *
 * Negative and non-finite inputs collapse to `0`.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const v = Math.round(n);
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    const thousands = v / 1000;
    return `${(Math.round(thousands * 10) / 10).toFixed(1)}k`;
  }
  const millions = v / 1_000_000;
  return `${(Math.round(millions * 10) / 10).toFixed(1)}M`;
}

/**
 * Render the thinking-effort segment, or `undefined` when nothing should
 * be shown. The cases:
 *
 *   - level is `off` or `minimal`           → undefined (no segment)
 *   - non-thinking content has streamed     → undefined (suppressed even
 *     since the most recent thinking_start    if the provider keeps the
 *                                              thinking content block
 *                                              technically open while
 *                                              text streams alongside;
 *                                              a *new* `thinking_start`
 *                                              clears the flag and
 *                                              reopens the live segment)
 *   - currently thinking, in-block < 20 s   → "thinking with <level> effort"
 *   - currently thinking, in-block ≥ 20 s   → "still thinking with <level> effort"
 *   - thinking ended, no text/toolcall yet  → "thought for Ns" (cumulative)
 *   - not thinking, no block ended yet      → undefined
 *
 * Note: `hasStreamedNonThinkingContent` is checked *before*
 * `activeStartedAtMs` because some providers (e.g. anthropic with
 * extended thinking + interleaved text) keep the thinking block
 * technically open while text content streams in parallel - we want
 * the visible-to-the-user behaviour ("text is appearing") to win over
 * the wire-level state ("thinking content block is still open").
 */
export function formatThinkingEffort(state: LabelSuffixState, level: ThinkingLevel, nowMs: number): string | undefined {
  if (level !== 'low' && level !== 'medium' && level !== 'high' && level !== 'xhigh') return undefined;
  const renderedLevel = level === 'xhigh' ? 'extra-high' : level;
  const { activeStartedAtMs, hasFinishedAny, cumulativeMs, hasStreamedNonThinkingContent } = state.thinking;
  if (hasStreamedNonThinkingContent) return undefined;
  if (activeStartedAtMs !== undefined) {
    const inBlockMs = nowMs - activeStartedAtMs;
    const prefix = inBlockMs >= STILL_THINKING_THRESHOLD_MS ? 'still thinking' : 'thinking';
    return `${prefix} with ${renderedLevel} effort`;
  }
  if (hasFinishedAny) {
    // Clamp to >=1s so a sub-second block doesn't render "thought for 0s".
    return `thought for ${formatElapsed(Math.max(1000, cumulativeMs))}`;
  }
  return undefined;
}

function formatTokenSegment(state: LabelSuffixState, liveInputTokens?: number): string | undefined {
  if (state.phase === 'uplink') {
    // Prefer the largest honest signal: cumulative real input from
    // committed messages + provider-streamed partial input, with the
    // caller's `liveInputTokens` as a floor for providers that don't
    // stream usage at all.
    const realInput = state.committedUsage.input + (state.currentUsage?.input ?? 0);
    const floor = liveInputTokens && liveInputTokens > 0 ? liveInputTokens : 0;
    const tokens = Math.max(realInput, floor);
    if (tokens <= 0) return undefined;
    return `↑ ${formatTokens(tokens)} tokens`;
  }
  // Downlink: show real output tokens when the provider streams them,
  // otherwise estimate from accumulated delta byte count so the counter
  // still ticks up live. Both signals are added to the committed total
  // so the display grows monotonically across turns.
  const realOutputThisMessage = state.currentUsage?.output ?? 0;
  const estimateThisMessage = Math.ceil(state.currentMessageOutputBytes / BYTES_PER_TOKEN);
  const liveThisMessage = Math.max(realOutputThisMessage, estimateThisMessage);
  const tokens = state.committedUsage.output + liveThisMessage;
  if (tokens <= 0) return undefined;
  return `↓ ${formatTokens(tokens)} tokens`;
}

/**
 * Assemble the parenthesised suffix string. Returns `(elapsed)` at
 * minimum; appends a token segment when usage has been observed and the
 * relevant direction has > 0 tokens, then a thinking segment when one
 * is applicable. Segments are joined by ` · ` to match claude-code's
 * separator.
 *
 * `liveInputTokens` (optional) is whatever per-turn input count the
 * caller wants displayed when the provider hasn't streamed
 * `partial.usage.input` yet. The extension passes the *delta* of
 * `getContextUsage().tokens` since the last `message_end` so the ↑
 * segment shows only the new content this turn (tool result / next
 * user message), not the cumulative full context size.
 */
export function formatSuffix(
  state: LabelSuffixState,
  level: ThinkingLevel,
  nowMs: number,
  liveInputTokens?: number,
): string {
  const elapsedMs = nowMs - state.loopStartedAtMs;
  const parts: string[] = [formatElapsed(elapsedMs)];

  const tokenSegment = formatTokenSegment(state, liveInputTokens);
  if (tokenSegment !== undefined) parts.push(tokenSegment);

  const thinkingSegment = formatThinkingEffort(state, level, nowMs);
  if (thinkingSegment !== undefined) parts.push(thinkingSegment);

  return `(${parts.join(' · ')})`;
}

/**
 * Wrap text in a faint truecolor SGR so it renders as dim grey and
 * resets all attributes at the close. Suitable for the trailing parens
 * appended to the rainbow-shimmered `Thinking...` label - the full reset
 * (`\x1b[0m`) is fine here because the suffix is always last.
 */
export function dimText(text: string): string {
  return `${DIM_OPEN}${text}${DIM_CLOSE}`;
}
