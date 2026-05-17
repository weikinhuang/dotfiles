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
 * Pi UI surface used:
 *   ctx.ui.setWorkingIndicator({ frames, intervalMs })
 *     - pi auto-cycles the pre-rendered frame array while streaming.
 *   ctx.ui.setWorkingMessage(text)
 *     - replaces the leading "Working" label verbatim. We re-call this
 *       on a 80 ms ticker bound to agent_start / agent_end so the label
 *       shimmers in sync with the indicator beat.
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
 * Future hook: the label is produced by `renderLabel(tick)`; swap that
 * function for one that calls a tiny model (or any other generator) and
 * the shimmer keeps working.
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
 * Produce the label string for tick `tick`. Today: a static "Thinking..."
 * with rainbow shimmer. Replace with a tiny-model call later without
 * touching the rest of this extension.
 */
function renderLabel(tick: number): string {
  return shimmerLabel(DEFAULT_LABEL, tick);
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

  function applyIndicator(ctx: ExtensionContext): void {
    ctx.ui.setWorkingIndicator(indicatorFor(mode));
  }

  function applyLabel(ctx: ExtensionContext): void {
    if (mode === 'default') {
      ctx.ui.setWorkingMessage(undefined);
    } else {
      ctx.ui.setWorkingMessage(renderLabel(tick));
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
    applyIndicator(ctx);
    // Don't start the label ticker yet - pi only renders the loader during
    // streaming. Label gets seeded on agent_start.
  });

  pi.on('agent_start', async (_event, ctx) => {
    applyIndicator(ctx);
    startLabelTicker(ctx);
  });

  pi.on('agent_end', async (_event, ctx) => {
    stopLabelTicker();
    // Reset label so the next turn doesn't briefly flash a stale shimmer
    // frame before agent_start kicks in again.
    if (mode !== 'default') {
      ctx.ui.setWorkingMessage(renderLabel(0));
    }
  });

  pi.on('session_shutdown', async () => {
    stopLabelTicker();
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
