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

/**
 * RGB equivalent of xterm-256 grey-245 - the baseline channel value the
 * thinking-effort pulse breathes around. Keeping it identical to the
 * 256-color path means a breatheDepth=0 pulse reads identically to the
 * static `dimText` wrap.
 */
const PULSE_CENTRE_RGB = 138;
const DEFAULT_BREATHE_SPEED_HZ = 0.5;
const DEFAULT_BREATHE_DEPTH = 15;
/**
 * Frames-per-second the label ticker runs at. The pulse formula uses
 * this to convert `breatheSpeed` (cycles/sec) into a per-tick phase
 * advance. Kept in lockstep with `FRAME_INTERVAL_MS` in the extension
 * shell (50 ms → 20 FPS); changing one without the other would warp the
 * pulse cadence.
 */
const PULSE_FRAMES_PER_SECOND = 20;

/**
 * Return true when SGR styling should be skipped (NO_COLOR set to any
 * non-empty value, or stdout is explicitly not a TTY). Both `dimText` and
 * `pulseDimText` consult this so the suffix renders consistently when
 * piped or under NO_COLOR.
 *
 * `env` and `isTty` are injectable so the gate is unit-testable without
 * mutating `process.env` / faking `process.stdout`; production callers
 * (`dimText` / `pulseDimText`) rely on the `process.*` defaults.
 */
export function shouldSkipStyling(
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean | undefined = (process.stdout as { isTTY?: boolean } | undefined)?.isTTY,
): boolean {
  const noColor = env.NO_COLOR;
  if (typeof noColor === 'string' && noColor !== '') return true;
  if (isTty === false) return true;
  return false;
}

// Chosen to match pi-ai's `ThinkingLevel`. Declared locally so this module
// stays under the lib/AGENTS.md "no @earendil-works imports" rule. Kept in
// lockstep with `packages/agent/src/types.ts` in the pi repo - currently
// `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
 * Wrap text in a faint truecolor SGR so it renders as dim grey and
 * resets all attributes at the close. Suitable for the trailing parens
 * appended to the rainbow-shimmered `Thinking...` label - the full reset
 * (`\x1b[0m`) is fine here because the suffix is always last.
 *
 * Returns `text` unchanged when `NO_COLOR` is set (any non-empty value)
 * or `process.stdout.isTTY === false` so the suffix degrades gracefully
 * when piped or under explicit color-off requests. The same gate sits
 * inside {@link pulseDimText}, in lockstep, so the two-pass render in
 * {@link formatSuffix} keeps both segments consistent.
 */
export function dimText(text: string): string {
  if (shouldSkipStyling()) return text;
  return `${DIM_OPEN}${text}${DIM_CLOSE}`;
}

/**
 * Optional knobs accepted by {@link pulseDimText}.
 *
 *   - `breatheSpeed`: cycles per second. Default {@link DEFAULT_BREATHE_SPEED_HZ}
 *     (0.5 Hz ≈ 2 second period, matching claude-code's pulse cadence
 *     by eye). Values that are non-finite or `<= 0` short-circuit to a
 *     static {@link dimText} render so `PI_WAVEFORM_THINKING_PULSE_HZ=0`
 *     does what users expect rather than letting `cos(0) = 1` paint a
 *     stuck-at-peak frame forever.
 *   - `breatheDepth`: half-amplitude channel swing around the
 *     {@link PULSE_CENTRE_RGB} baseline. Default
 *     {@link DEFAULT_BREATHE_DEPTH} (= 15, so peak 153, trough 123).
 *     `0` reproduces today's static dim render. Larger values clamp at
 *     `[0, 255]` so an absurd override can't emit invalid SGR.
 */
export interface PulseDimOpts {
  breatheSpeed?: number;
  breatheDepth?: number;
}

/**
 * Wrap `text` in a faint + truecolor SGR whose channel value breathes
 * with a slow cosine of `tick`. Used by {@link formatSuffix} to pulse
 * the thinking-effort segment of the suffix while leaving the other
 * segments static.
 *
 * Compatibility notes:
 *
 *   - `NO_COLOR` (any non-empty value) and `process.stdout.isTTY === false`
 *     short-circuit to plain unstyled `text` - same gate as {@link dimText}.
 *   - Some tmux/screen passthrough configs drop one attribute when faint
 *     (`\x1b[2m`) is combined with truecolor (`\x1b[38;2;…m`). We pick the
 *     truecolor channel as the primary signal so a session that drops the
 *     faint attribute still gets a visible pulse, just without the dim
 *     baseline.
 *   - `tick = 0` always paints `cos(0) = 1` → the brightest frame, so a
 *     freshly-opened thinking block doesn't first appear at the trough.
 */
export function pulseDimText(text: string, tick: number, opts: PulseDimOpts = {}): string {
  if (text === '') return '';
  if (shouldSkipStyling()) return text;
  const breatheSpeed = opts.breatheSpeed ?? DEFAULT_BREATHE_SPEED_HZ;
  const breatheDepth = opts.breatheDepth ?? DEFAULT_BREATHE_DEPTH;
  // `<= 0` and non-finite Hz fall through to the static dim render so
  // `PI_WAVEFORM_THINKING_PULSE_HZ=0` switches the pulse off rather than
  // letting `cos(0) = 1` freeze the segment at peak forever. A
  // `breatheDepth=0` swing produces the same byte output (no amplitude
  // means no SGR change), so we delegate to `dimText` in both cases for
  // a byte-for-byte match with today's static render.
  if (!Number.isFinite(breatheSpeed) || breatheSpeed <= 0) return dimText(text);
  if (!Number.isFinite(breatheDepth) || breatheDepth <= 0) return dimText(text);
  const angle = (2 * Math.PI * tick * breatheSpeed) / PULSE_FRAMES_PER_SECOND;
  const raw = PULSE_CENTRE_RGB + breatheDepth * Math.cos(angle);
  const v = Math.max(0, Math.min(255, Math.round(raw)));
  return `\x1b[2;38;2;${v};${v};${v}m${text}\x1b[0m`;
}

/**
 * Optional knobs accepted by {@link formatSuffix}.
 *
 *   - `inputDeltaTokens`: per-turn input-token floor for the ↑ segment.
 *     Same role as the old positional `liveInputTokens` argument.
 *   - `tick`: when supplied, switches the renderer to a two-pass styled
 *     output (dim baseline + breathing pulse on the thinking-effort
 *     segment). Omit to get today's plain unstyled `(…)` string for the
 *     caller to wrap.
 *   - `breatheSpeed`, `breatheDepth`: forwarded to {@link pulseDimText}.
 */
export interface FormatSuffixOpts {
  inputDeltaTokens?: number;
  tick?: number;
  breatheSpeed?: number;
  breatheDepth?: number;
}

/**
 * Assemble the parenthesised suffix string. Returns `(elapsed)` at
 * minimum; appends a token segment when usage has been observed and the
 * relevant direction has > 0 tokens, then a thinking segment when one
 * is applicable. Segments are joined by ` · ` to match claude-code's
 * separator.
 *
 * `opts.inputDeltaTokens` (optional) is whatever per-turn input count
 * the caller wants displayed when the provider hasn't streamed
 * `partial.usage.input` yet. The extension passes the *delta* of
 * `getContextUsage().tokens` since the last `message_end` so the ↑
 * segment shows only the new content this turn (tool result / next
 * user message), not the cumulative full context size.
 *
 * When `opts.tick` is supplied, the return value is pre-styled: the
 * thinking-effort segment is wrapped in a {@link pulseDimText} cosine
 * pulse and everything else (parens, elapsed, tokens, separators) is
 * wrapped in the same `\x1b[2;38;5;245m…\x1b[0m` baseline `dimText` uses
 * - so a single `formatSuffix` call replaces the old
 * `dimText(formatSuffix(…))` wrap at the call site. When `opts.tick` is
 * omitted the return value is the plain unstyled `(…)` string (today's
 * behaviour) and the caller is still expected to wrap it.
 */
export function formatSuffix(
  state: LabelSuffixState,
  level: ThinkingLevel,
  nowMs: number,
  opts: FormatSuffixOpts = {},
): string {
  const elapsedMs = nowMs - state.loopStartedAtMs;
  const parts: string[] = [formatElapsed(elapsedMs)];

  const tokenSegment = formatTokenSegment(state, opts.inputDeltaTokens);
  if (tokenSegment !== undefined) parts.push(tokenSegment);

  const thinkingSegment = formatThinkingEffort(state, level, nowMs);
  if (thinkingSegment !== undefined) parts.push(thinkingSegment);

  if (opts.tick === undefined) {
    return `(${parts.join(' · ')})`;
  }

  // Two-pass styled render. When there's no thinking segment to pulse,
  // fall back to a single dim wrap so the output matches today's static
  // render exactly - the pulse is opt-in per-segment, not per-suffix.
  if (thinkingSegment === undefined) {
    return dimText(`(${parts.join(' · ')})`);
  }
  const headParts = parts.slice(0, -1).join(' · ');
  const prefix = `(${headParts} · `;
  const pulse = pulseDimText(thinkingSegment, opts.tick, {
    breatheSpeed: opts.breatheSpeed,
    breatheDepth: opts.breatheDepth,
  });
  return `${dimText(prefix)}${pulse}${dimText(')')}`;
}
