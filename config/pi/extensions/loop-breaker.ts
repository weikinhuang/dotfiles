/**
 * Loop-breaker extension for pi.
 *
 * Small self-hosted models regularly get stuck calling the same tool
 * with the same arguments 3+ times in a row — `read` with the same
 * offset, `bash` rerunning the same failing command, `grep` for a
 * pattern that never matches. They then burn 5–10 turns before giving
 * up or asking the user.
 *
 * This extension keeps a rolling window of recent `(toolName, input)`
 * hashes across the session. When the same hash repeats `threshold`
 * times inside the last `window` calls, it injects a steering
 * message via `pi.sendMessage({ deliverAs: 'steer' })` that tells
 * the model to change approach.
 *
 * Design notes:
 *
 *   - We DO NOT block the tool call. Blocking interacts badly with
 *     `verify-before-claim` / `todo` guardrails and removes the "one
 *     more try with different inputs" escape hatch. Steering is
 *     strictly additive.
 *   - The history survives across turns within a session — a slow
 *     loop ("same read every turn for 3 turns") is the exact case
 *     we want to catch. It resets only on (a) new user input that
 *     isn't our own synthesized nudge, (b) session_start.
 *   - On trigger, we clear the history so the nudge doesn't fire
 *     again on the very next call while the model is pivoting.
 *   - There are no per-tool exemptions by default. If we see false
 *     positives on legitimately-idempotent calls, add them.
 *
 * Environment:
 *   PI_LOOP_BREAKER_DISABLED=1       skip the extension entirely
 *   PI_LOOP_BREAKER_THRESHOLD=N      repeats required to trigger (default 3)
 *   PI_LOOP_BREAKER_WINDOW=N         rolling window size (default 6)
 *   PI_LOOP_BREAKER_DEBUG=1          ctx.ui.notify every decision
 *   PI_LOOP_BREAKER_TRACE=<path>     append one line per decision to <path>
 */

import { appendFileSync } from 'node:fs';

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import { buildNudge, makeKey, pushAndCheck } from '../../../lib/node/pi/loop-breaker.ts';

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW = 6;
const STATUS_KEY = 'loop-breaker';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default function loopBreaker(pi: ExtensionAPI): void {
  if (process.env.PI_LOOP_BREAKER_DISABLED === '1') return;

  const threshold = parsePositiveInt(process.env.PI_LOOP_BREAKER_THRESHOLD, DEFAULT_THRESHOLD);
  const windowSize = parsePositiveInt(process.env.PI_LOOP_BREAKER_WINDOW, DEFAULT_WINDOW);
  const debug = process.env.PI_LOOP_BREAKER_DEBUG === '1';
  const tracePath = process.env.PI_LOOP_BREAKER_TRACE;

  const trace = (msg: string): void => {
    if (!tracePath) return;
    try {
      appendFileSync(tracePath, `[loop-breaker] ${msg}\n`, 'utf8');
    } catch {
      /* ignore — never break a turn over diagnostics */
    }
  };

  const history: string[] = [];

  const reset = (ctx: ExtensionContext | undefined, reason: string): void => {
    if (history.length === 0) return;
    history.length = 0;
    trace(`reset (${reason})`);
    if (ctx) ctx.ui.setStatus(STATUS_KEY, undefined as unknown as string);
  };

  pi.on('session_start', (_event, ctx) => {
    reset(ctx, 'session_start');
  });

  pi.on('input', (event, ctx) => {
    // Skip our own synthesized nudges so repeated steering doesn't
    // keep wiping the history.
    if (event.source === 'extension') return;
    reset(ctx, 'user input');
  });

  pi.on('tool_call', (event, ctx) => {
    const key = makeKey(event.toolName, event.input);
    const check = pushAndCheck(history, key, windowSize, threshold);

    if (check.kind !== 'repeat') {
      if (debug) ctx.ui.notify(`loop-breaker: ok (${event.toolName}, window=${history.length})`, 'info');
      return undefined;
    }

    const nudge = buildNudge(event.toolName, check.count);
    trace(`trigger tool=${event.toolName} count=${check.count}`);
    if (debug) {
      ctx.ui.notify(`loop-breaker: detected ${check.count} repeats of ${event.toolName}, steering`, 'warning');
    }
    ctx.ui.setStatus(STATUS_KEY, `⟳ loop-breaker: steered (${check.count} repeats)`);

    // Clear the history so we don't retrigger on call N+1 while the
    // model is pivoting to a new approach.
    history.length = 0;

    try {
      pi.sendMessage(
        {
          customType: 'loop-breaker-nudge',
          content: nudge,
          display: true,
        },
        { deliverAs: 'steer' },
      );
    } catch (e) {
      // sendMessage shouldn't throw; if it does, surface so the nudge
      // failure is visible.
      ctx.ui.notify(`loop-breaker: failed to deliver nudge: ${String(e)}`, 'error');
    }

    return undefined;
  });

  pi.on('session_shutdown', () => {
    history.length = 0;
  });
}
