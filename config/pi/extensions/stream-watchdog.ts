/**
 * Stream-watchdog extension for pi — abort when the model response
 * stream has gone silent.
 *
 * Complement to `stall-recovery.ts`, which fires AFTER a turn ends
 * empty. This extension fires DURING a turn when nothing is flowing —
 * the classic "llama.cpp (or any local / remote provider) has the HTTP
 * connection open but has stopped emitting tokens" hang. Common on
 * thinking-level=high with modest local hardware; also seen on flaky
 * provider sides.
 *
 * How it works:
 *
 *   1. Subscribe to pi's assistant-stream lifecycle events:
 *        - `message_start` (role=assistant) → start tracking.
 *        - `message_update`                 → bump lastHeartbeat.
 *        - `message_end`   (role=assistant) → stop tracking.
 *
 *   2. While a stream is in flight, a `setInterval` poll asks the pure
 *      helper `detectStale()` whether the current stream has gone quiet
 *      for `>= stallMs`. If so:
 *        - Always: `ctx.ui.notify` a warning with the silent duration.
 *        - Default: `ctx.abort()` — programmatic equivalent of Esc;
 *          the next turn's stall-recovery (or plain retry) can take
 *          over.
 *        - Opt-out via `PI_STREAM_WATCHDOG_ABORT=0` if you just want
 *          the notify.
 *
 *   3. Single-fire per stream: once a stream is flagged, the poll
 *      doesn't re-notify until a heartbeat arrives or the stream ends
 *      and restarts. The notified latch lives in the pure helper so
 *      the extension itself stays minimal.
 *
 *   4. State is dropped on `session_start`, `session_shutdown`, and
 *      real (non-extension) user input. A stale stream entry left by a
 *      dropped `message_end` won't haunt the next session.
 *
 * Scope choices:
 *
 *   - NO tool-execution watchdog. Bash test suites, research subagents,
 *     and long network calls legitimately run minutes-to-hours with no
 *     partial output. Pi's tool phase and stream phase don't overlap in
 *     the event model, so watching only `message_*` events is
 *     sufficient to catch "pi is hung waiting on the model" regardless
 *     of how long the preceding tool took.
 *   - NO force-kill behaviour. `ctx.abort()` is cooperative and matches
 *     what pressing Esc does; if the provider socket is genuinely dead
 *     at the OS level, Node will eventually reap it.
 *
 * Composition with stall-recovery:
 *
 *   When this extension aborts a hung stream, pi emits `agent_end` with
 *   `stopReason === 'aborted'` (or `'error'` depending on provider
 *   adapter). `stall-recovery`'s classifier explicitly returns `null`
 *   on `aborted` so it doesn't auto-retry a user-initiated (or here,
 *   watchdog-initiated) cancel. If the provider reports the abort as a
 *   generic error instead, `stall-recovery` WILL retry — which is the
 *   desired behaviour for "stream hung → abort → re-issue".
 *
 * Environment:
 *   PI_STREAM_WATCHDOG_DISABLED=1        skip the extension entirely
 *   PI_STREAM_WATCHDOG_STALL_MS=N        silence threshold, ms (default 60000)
 *   PI_STREAM_WATCHDOG_POLL_MS=N         poll interval, ms (default 5000)
 *   PI_STREAM_WATCHDOG_ABORT=0           notify only; do not auto-abort
 *   PI_STREAM_WATCHDOG_VERBOSE=1         log start/stale/end decisions
 *                                        via ctx.ui.notify (useful for
 *                                        tuning against a noisy model)
 */

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  clear,
  createState,
  detectStale,
  recordEnd,
  recordHeartbeat,
  recordStart,
} from '../../../lib/node/pi/stream-watchdog.ts';

const STATUS_KEY = 'stream-watchdog';
const DEFAULT_STALL_MS = 60_000;
const DEFAULT_POLL_MS = 5_000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default function streamWatchdog(pi: ExtensionAPI): void {
  if (process.env.PI_STREAM_WATCHDOG_DISABLED === '1') return;

  const stallMs = parsePositiveInt(process.env.PI_STREAM_WATCHDOG_STALL_MS, DEFAULT_STALL_MS);
  const pollMs = parsePositiveInt(process.env.PI_STREAM_WATCHDOG_POLL_MS, DEFAULT_POLL_MS);
  const autoAbort = process.env.PI_STREAM_WATCHDOG_ABORT !== '0';
  const verbose = process.env.PI_STREAM_WATCHDOG_VERBOSE === '1';

  const state = createState();
  let timer: ReturnType<typeof setInterval> | null = null;
  // Captured on the most recent `message_start` / `message_update` so
  // the poll callback can reach `ctx.ui` and `ctx.abort` without being
  // wired directly into the event-handler arguments.
  let latestCtx: ExtensionContext | undefined;

  const clearStatus = (ctx: ExtensionContext | undefined): void => {
    ctx?.ui.setStatus(STATUS_KEY, undefined as unknown as string);
  };

  const stopPolling = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  const startPolling = (): void => {
    if (timer) return;
    timer = setInterval(() => {
      // Safety net: if nothing is in flight, turn the timer off. This
      // shouldn't happen (message_end clears it explicitly) but keeps
      // the extension from burning CPU if an end event were ever lost.
      if (!state.current) {
        stopPolling();
        return;
      }
      const ctx = latestCtx;
      if (!ctx) return;

      const nowMs = Date.now();
      const stale = detectStale(state, nowMs, stallMs);
      if (!stale) return;

      const silentSec = Math.round((nowMs - stale.lastHeartbeat) / 1000);
      const elapsedSec = Math.round((nowMs - stale.startedAt) / 1000);

      if (autoAbort) {
        ctx.ui.notify(`Stream watchdog: no tokens for ${silentSec}s (${elapsedSec}s total). Aborting turn.`, 'warning');
        ctx.ui.setStatus(STATUS_KEY, `⟳ stream-watchdog: aborted after ${silentSec}s of silence`);
        try {
          ctx.abort();
        } catch (e) {
          ctx.ui.notify(`stream-watchdog: abort() failed: ${String(e)}`, 'error');
        }
      } else {
        ctx.ui.notify(
          `Stream watchdog: stream silent for ${silentSec}s (${elapsedSec}s total) — press Esc to cancel.`,
          'warning',
        );
        ctx.ui.setStatus(STATUS_KEY, `⟳ stream-watchdog: stream silent ${silentSec}s`);
      }
    }, pollMs);
    // Don't keep the Node process alive solely for this poll timer.
    if (typeof timer.unref === 'function') timer.unref();
  };

  pi.on('session_start', (_event, ctx) => {
    latestCtx = ctx;
    clear(state);
    stopPolling();
    clearStatus(ctx);
  });

  pi.on('input', (event, ctx) => {
    // Only reset on real user input. Synthesized follow-ups from other
    // extensions (stall-recovery, loop-breaker) shouldn't flush our
    // state — if the model is already mid-stream in response to our
    // own nudge, we still want to watch for silence.
    if (event.source === 'extension') return;
    latestCtx = ctx;
    clear(state);
    stopPolling();
    clearStatus(ctx);
  });

  pi.on('message_start', (event, ctx) => {
    const msg = (event as { message?: { role?: string; responseId?: string } }).message;
    if (!msg || msg.role !== 'assistant') return;
    latestCtx = ctx;
    recordStart(state, Date.now(), msg.responseId);
    startPolling();
    if (verbose) ctx.ui.notify(`stream-watchdog: start (${msg.responseId ?? 'no-id'})`, 'info');
  });

  pi.on('message_update', (_event, ctx) => {
    // message_update fires for assistant streaming exclusively (user /
    // toolResult messages don't stream), so we don't need to re-check
    // the role here.
    latestCtx = ctx;
    recordHeartbeat(state, Date.now());
  });

  pi.on('message_end', (event, ctx) => {
    const msg = (event as { message?: { role?: string } }).message;
    if (!msg || msg.role !== 'assistant') return;
    latestCtx = ctx;
    recordEnd(state);
    stopPolling();
    clearStatus(ctx);
    if (verbose) ctx.ui.notify(`stream-watchdog: end`, 'info');
  });

  pi.on('session_shutdown', () => {
    clear(state);
    stopPolling();
  });
}
