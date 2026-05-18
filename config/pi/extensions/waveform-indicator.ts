/**
 * Waveform working indicator.
 *
 * Replaces pi's default braille spinner with a music-style scrolling
 * waveform rendered in 1-dot-thick braille bars (two waveform samples
 * per glyph) and a rainbow shimmer that drifts across the wave. The
 * `Working...` label is replaced with `Thinking...` and shimmers in the
 * same hue band, on its own ticker since pi doesn't expose the indicator's
 * frame index for syncing.
 *
 * The shimmering label is followed by a dim claude-code-style suffix in
 * parens: `Thinking... (5s · ↑ 185 tokens · thinking with medium effort)`.
 * Elapsed time covers the whole agent loop; ↑/↓ token counts reset on
 * each `turn_start` so they reflect the current turn only (claude-code
 * semantics). The thinking segment reflects the current turn's reasoning
 * blocks (live "thinking with <level> effort" → "still thinking" after
 * 20 s in-block → "thought for Ns" once the block ends). The state
 * machine + format helpers live in
 * `lib/node/pi/waveform-indicator-suffix.ts`.
 *
 * Pi UI surface used:
 *   ctx.ui.setWorkingIndicator({ frames, intervalMs })
 *     - pi auto-cycles the pre-rendered frame array while streaming.
 *   ctx.ui.setWorkingMessage(text)
 *     - replaces the leading "Working" label verbatim. We re-call this
 *       on a 80 ms ticker bound to agent_start / agent_end so the label
 *       shimmers in sync with the indicator beat.
 *   pi.on('message_update' | 'message_end' | 'turn_start' | ...)
 *     - drives the suffix state machine: usage / phase / thinking blocks.
 *   pi.getThinkingLevel()
 *     - read each tick so the suffix reflects the level the user has
 *       currently selected (no caching of `thinking_level_select`).
 *
 * Knobs:
 *   /waveform                 show current style
 *   /waveform scroll          right-to-left scrolling waveform (default)
 *   /waveform spectrum        independent bouncing bars, EQ-style heat-map color
 *   /waveform off             hide the indicator entirely (keep label)
 *   /waveform reset           restore pi's default spinner + "Working..." label
 *
 * The chosen style persists to `~/.pi/waveform-indicator.json` so it
 * sticks across pi sessions. `/waveform reset` clears the file. The
 * `PI_WAVEFORM_INDICATOR_MODE` env var overrides the file when set, for
 * one-shot per-shell overrides.
 *
 * Future hook: `renderLabel(tick, suffix)` builds the head from
 * `shimmerLabel`; swap that function for one that calls a tiny model
 * (or any other generator) and the shimmer + dim suffix keep working.
 *
 * Environment:
 *   PI_WAVEFORM_INDICATOR_DISABLED=1   leave pi's default indicator alone
 *   PI_WAVEFORM_INDICATOR_MODE=<mode>  override the persisted mode for
 *                                     this session (scroll|spectrum|off|default)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type ExtensionAPI,
  type ExtensionContext,
  type WorkingIndicatorOptions,
} from '@earendil-works/pi-coding-agent';

import { buildIndicatorFrames, buildSpectrumFrames, shimmerLabel } from '../../../lib/node/pi/waveform-indicator.ts';
import {
  type WaveformMode,
  clearWaveformState,
  resolveInitialWaveformMode,
  writeWaveformState,
} from '../../../lib/node/pi/waveform-indicator-state.ts';
import {
  type LabelSuffixState,
  dimText,
  formatSuffix,
  newLabelSuffixState,
  resetTurnState,
} from '../../../lib/node/pi/waveform-indicator-suffix.ts';

type Mode = WaveformMode;

const STATE_PATH = join(homedir(), '.pi', 'waveform-indicator.json');

const FRAME_INTERVAL_MS = 50;
// Per-mode frame intervals. The label ticker stays at FRAME_INTERVAL_MS
// because shimmer drift speed is independent of the indicator rate.
const SCROLL_FRAME_INTERVAL_MS = 80;
const SPECTRUM_FRAME_INTERVAL_MS = 50;
const DEFAULT_LABEL = 'Thinking...';
const HIDDEN_INDICATOR: WorkingIndicatorOptions = { frames: [] };

/**
 * Produce the label string for tick `tick`. The base label is a
 * rainbow-shimmered "Thinking..."; when an agent loop is active and a
 * suffix state is being tracked, append a dim claude-code-style suffix
 * like ` (5s · ↑ 185 tokens · thinking with medium effort)`. Replace
 * the inner shimmer with a tiny-model call later without touching the
 * suffix path.
 */
function renderLabel(tick: number, suffix: string | undefined): string {
  const head = shimmerLabel(DEFAULT_LABEL, tick);
  if (suffix === undefined) return head;
  return `${head} ${dimText(suffix)}`;
}

function indicatorFor(mode: Mode): WorkingIndicatorOptions | undefined {
  switch (mode) {
    case 'scroll':
      return {
        frames: buildIndicatorFrames(),
        intervalMs: SCROLL_FRAME_INTERVAL_MS,
      };
    case 'spectrum':
      return {
        frames: buildSpectrumFrames(),
        intervalMs: SPECTRUM_FRAME_INTERVAL_MS,
      };
    case 'off':
      return HIDDEN_INDICATOR;
    case 'default':
      return undefined;
  }
}

function describeMode(mode: Mode): string {
  switch (mode) {
    case 'scroll':
      return 'scrolling waveform';
    case 'spectrum':
      return 'spectrum bars';
    case 'off':
      return 'hidden';
    case 'default':
      return 'pi default spinner';
  }
}

export default function extension(pi: ExtensionAPI): void {
  if (process.env.PI_WAVEFORM_INDICATOR_DISABLED === '1') return;

  let mode: Mode = resolveInitialWaveformMode(STATE_PATH);
  let labelTimer: ReturnType<typeof setInterval> | null = null;
  let tick = 0;
  // Tracks per-loop counters that drive the dim suffix. `null` outside
  // an active agent loop so the label renders without parens between
  // turns / before any agent_start.
  let suffixState: LabelSuffixState | null = null;
  // Cached so the per-tick suffix builder can read live context size
  // without a fresh event payload. Many providers leave
  // `partial.usage.input` at zero until message_end; getContextUsage()
  // is the synchronous source of truth pi already exposes.
  let lastCtx: ExtensionContext | null = null;
  // Context-token count snapshot used as the baseline for the ↑
  // segment's per-turn delta. Initialised at `session_start` (= system
  // prompt + tools, before any user input) so turn 1's ↑ shows just
  // the user-prompt size; refreshed at every assistant `message_end`
  // so subsequent turns show only the new content (tool result / next
  // user message) appended since the previous LLM call. Persists across
  // agent loops within the same session so a second `agent_start`
  // (e.g. user asks a follow-up question) doesn't regress to the
  // cumulative full-context display.
  let prevContextTokensSnapshot: number | undefined = undefined;

  function computeSuffix(): string | undefined {
    if (suffixState === null) return undefined;
    // Read the level fresh each tick: the user may have changed it via
    // /thinking-level mid-turn and we want the next frame to reflect it.
    let level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' = 'off';
    try {
      level = pi.getThinkingLevel();
    } catch {
      // ExtensionAPI is meant to expose this synchronously, but keep the
      // suffix renderable even if a future pi version flakes.
    }
    let inputDeltaTokens: number | undefined;
    try {
      const cur = lastCtx?.getContextUsage()?.tokens ?? undefined;
      if (cur === undefined) {
        inputDeltaTokens = undefined;
      } else if (prevContextTokensSnapshot === undefined) {
        // Snapshot wasn't captured (e.g. session_start fired before pi
        // had populated context). Fall back to the full current context
        // size so the very first request still shows an honest count.
        inputDeltaTokens = cur;
      } else {
        // Compaction (or any other shrink) can make `cur` smaller than
        // the snapshot - clamp the delta to >=0 and let the floor logic
        // in formatTokenSegment suppress the segment when it ends up at 0.
        inputDeltaTokens = Math.max(0, cur - prevContextTokensSnapshot);
      }
    } catch {
      // Same defensive try as above.
    }
    return formatSuffix(suffixState, level, Date.now(), inputDeltaTokens);
  }

  function applyIndicator(ctx: ExtensionContext): void {
    ctx.ui.setWorkingIndicator(indicatorFor(mode));
  }

  function applyLabel(ctx: ExtensionContext): void {
    if (mode === 'default') {
      ctx.ui.setWorkingMessage(undefined);
    } else {
      ctx.ui.setWorkingMessage(renderLabel(tick, computeSuffix()));
    }
  }

  function stopLabelTicker(): void {
    if (labelTimer) {
      clearInterval(labelTimer);
      labelTimer = null;
    }
  }

  function startLabelTicker(ctx: ExtensionContext): void {
    // Belt-and-braces: clear any stale timer before installing a new one
    // (e.g. after /reload or a missed agent_end).
    stopLabelTicker();
    if (mode === 'default') return;
    tick = 0;
    applyLabel(ctx);
    labelTimer = setInterval(() => {
      tick++;
      applyLabel(ctx);
    }, FRAME_INTERVAL_MS);
  }

  pi.on('session_start', async (_event, ctx) => {
    lastCtx = ctx;
    // Snapshot the initial context size (system prompt + tools, before
    // any user input is in scope) so the very first turn's ↑ segment
    // renders only the new user-prompt size rather than the full
    // cumulative context. For `reason: "resume" | "reload" | "fork"`
    // this captures the resumed transcript size, which is the right
    // baseline - we want the user's *new* input on the next turn to be
    // the displayed delta, not the entire restored history.
    try {
      const cur = ctx.getContextUsage()?.tokens;
      if (typeof cur === 'number') prevContextTokensSnapshot = cur;
    } catch {
      /* ignore - keeps prevContextTokensSnapshot undefined and we fall
       * back to displaying the full context size on turn 1. */
    }
    applyIndicator(ctx);
    // Don't start the label ticker yet - pi only renders the loader during
    // streaming. Label gets seeded on agent_start.
  });

  pi.on('agent_start', async (_event, ctx) => {
    lastCtx = ctx;
    suffixState = newLabelSuffixState(Date.now());
    // Note: we deliberately do NOT reset `prevContextTokensSnapshot`
    // here - that snapshot survives across agent loops in the same
    // session so a second user prompt also shows just its own delta
    // instead of the full cumulative context.
    applyIndicator(ctx);
    startLabelTicker(ctx);
  });

  pi.on('turn_start', async (_event, ctx) => {
    lastCtx = ctx;
    // Per-turn reset preserves the loop-level token totals but clears
    // phase / currentUsage / thinking - matching the spec where
    // "thought for Ns" only reflects the current turn's blocks.
    if (suffixState !== null) resetTurnState(suffixState);
  });

  pi.on('message_update', async (event, ctx) => {
    lastCtx = ctx;
    if (suffixState === null) return;
    const ev = event.assistantMessageEvent;
    // Pull the live usage off whichever payload this event variant carries.
    if (ev.type === 'done') {
      suffixState.currentUsage = { input: ev.message.usage.input, output: ev.message.usage.output };
    } else if (ev.type === 'error') {
      suffixState.currentUsage = { input: ev.error.usage.input, output: ev.error.usage.output };
    } else {
      suffixState.currentUsage = { input: ev.partial.usage.input, output: ev.partial.usage.output };
    }
    // Drive phase + thinking machine off the event's discriminator. Also
    // accumulate streamed delta byte counts as a live output-token
    // estimate for providers that don't emit `partial.usage.output`
    // until the final chunk - bytes / 4 ticks the ↓ counter live so the
    // user sees something happen during a slow generation.
    switch (ev.type) {
      case 'start':
        // Fresh assistant message starting; reset the per-message byte
        // accumulator so its estimate doesn't carry between messages.
        suffixState.currentMessageOutputBytes = 0;
        break;
      case 'text_start':
      case 'text_delta':
      case 'text_end':
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end':
        // Any non-thinking content event flips the phase and hides the
        // thinking segment. We set the flag on every variant (not just
        // `*_start`) because some providers skip the `_start` and emit
        // `_delta` directly.
        suffixState.phase = 'downlink';
        suffixState.thinking.hasStreamedNonThinkingContent = true;
        break;
      case 'thinking_start':
        suffixState.phase = 'downlink';
        // Always overwrite: a new thinking_start means a new block, and
        // the "still thinking" 20s timer must restart at zero per spec.
        suffixState.thinking.activeStartedAtMs = Date.now();
        // Reopen the thinking segment for this new block even if a
        // previous block had already streamed non-thinking content.
        // The flag will flip back to true on the next text/toolcall
        // event, hiding the segment again.
        suffixState.thinking.hasStreamedNonThinkingContent = false;
        break;
      case 'thinking_delta':
        // Thinking content event - no flag flip, just byte accumulation
        // (handled below).
        break;
      case 'thinking_end':
        if (suffixState.thinking.activeStartedAtMs !== undefined) {
          suffixState.thinking.cumulativeMs += Date.now() - suffixState.thinking.activeStartedAtMs;
          suffixState.thinking.activeStartedAtMs = undefined;
        }
        suffixState.thinking.hasFinishedAny = true;
        break;
    }
    // Accumulate streamed delta byte counts as a live output-token
    // estimate for providers that don't emit `partial.usage.output`
    // until the final chunk - bytes / 4 ticks the ↓ counter live so the
    // user sees something happen during a slow generation. Counts both
    // text and thinking deltas since both consume output token budget.
    if (ev.type === 'text_delta' || ev.type === 'thinking_delta' || ev.type === 'toolcall_delta') {
      if (typeof ev.delta === 'string') {
        suffixState.currentMessageOutputBytes += Buffer.byteLength(ev.delta, 'utf8');
      }
    }
  });

  pi.on('message_end', async (event, ctx) => {
    lastCtx = ctx;
    if (suffixState === null) return;
    const message = event.message;
    // AgentMessage is a discriminated union (User | Assistant | ToolResult
    // | custom). Only assistant messages carry a `usage`; the rest commit
    // nothing. Custom agent messages without `role` likewise no-op.
    if (typeof message !== 'object' || message === null) return;
    if ((message as { role?: string }).role !== 'assistant') return;
    const usage = (message as { usage?: { input: number; output: number } }).usage;
    if (usage === undefined) return;
    suffixState.committedUsage.input += usage.input;
    suffixState.committedUsage.output += usage.output;
    suffixState.currentUsage = undefined;
    // The byte-estimate counter has now been replaced by the real
    // committed output tokens; reset so the next message starts fresh.
    suffixState.currentMessageOutputBytes = 0;
    // Snapshot the post-LLM-call context size so the next turn's ↑
    // segment renders only the *new* content (tool results / next user
    // message), not the full cumulative context. Tool results get
    // appended between message_end and turn_end, so by the next
    // message_start the delta = (current context) - (this snapshot)
    // = size of new content this turn.
    try {
      const cur = ctx.getContextUsage()?.tokens;
      if (typeof cur === 'number') prevContextTokensSnapshot = cur;
    } catch {
      /* ignore */
    }
  });

  pi.on('agent_end', async (_event, ctx) => {
    lastCtx = ctx;
    stopLabelTicker();
    suffixState = null;
    // Note: we deliberately keep `prevContextTokensSnapshot` here -
    // a follow-up user prompt in the same session should compute its
    // ↑ delta against the post-last-message-end snapshot, not against
    // a freshly cleared baseline.
    // Reset label so the next turn doesn't briefly flash a stale shimmer
    // frame before agent_start kicks in again.
    if (mode !== 'default') {
      ctx.ui.setWorkingMessage(renderLabel(0, undefined));
    }
  });

  pi.on('session_shutdown', async () => {
    stopLabelTicker();
    suffixState = null;
    lastCtx = null;
    prevContextTokensSnapshot = undefined;
  });

  pi.registerCommand('waveform', {
    description: 'Set the streaming working indicator: scroll, spectrum, off, or reset (restore pi default).',
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg) {
        ctx.ui.notify(`Waveform indicator: ${describeMode(mode)}`, 'info');
        return;
      }
      if (arg !== 'scroll' && arg !== 'spectrum' && arg !== 'off' && arg !== 'reset') {
        ctx.ui.notify('Usage: /waveform [scroll|spectrum|off|reset]', 'error');
        return;
      }
      mode = arg === 'reset' ? 'default' : (arg as Mode);
      // Persist before applying so a UI failure mid-apply doesn't leave
      // the file out of sync with the user's expressed intent.
      try {
        if (arg === 'reset') {
          clearWaveformState(STATE_PATH);
        } else {
          writeWaveformState(STATE_PATH, mode);
        }
      } catch (e) {
        ctx.ui.notify(`Could not persist waveform mode to ${STATE_PATH}: ${(e as Error).message}`, 'error');
      }
      applyIndicator(ctx);
      // If we're mid-stream the label ticker is running - reapply now.
      if (labelTimer) {
        if (mode === 'default') {
          stopLabelTicker();
          ctx.ui.setWorkingMessage(undefined);
        } else {
          applyLabel(ctx);
        }
      } else if (mode === 'default') {
        ctx.ui.setWorkingMessage(undefined);
      }
      ctx.ui.notify(`Waveform indicator set to: ${describeMode(mode)}`, 'info');
    },
  });
}
