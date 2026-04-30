/**
 * Stall-recovery extension for pi — auto-retry when the model stops
 * without producing work.
 *
 * Companion to the `todo` extension's completion-claim guardrail. The two
 * handle orthogonal failure modes:
 *
 *   - `todo` guardrail: model claims done while open todos remain.
 *   - `stall-recovery`: model produces nothing at all (empty turn or
 *     provider error) — common with weaker local models, reasoning
 *     models whose "thinking" phase completes without emitting content,
 *     and transient network / rate-limit errors.
 *
 * They can't double-fire on the same turn: the todo guardrail requires a
 * completion-claim text, which only exists when the model produced
 * something; the stall classifier only fires on empty / errored turns.
 *
 * How it works:
 *
 *   1. On `agent_end`, extract the last assistant message from
 *      `event.messages` and classify it via `classifyAssistant()`. Fire
 *      on two unambiguous signals:
 *        a. `empty` — no text + no tool calls
 *        b. `error` — explicit error field on the message or event
 *
 *   2. If a stall was detected AND our retry budget for this user prompt
 *      isn't exhausted, inject a follow-up user message via
 *      `pi.sendUserMessage()` with a sentinel prefix. The follow-up
 *      triggers a fresh agent turn; if other extensions (like `todo`)
 *      inject context via `before_agent_start`, that happens
 *      automatically on the retry.
 *
 *   3. The budget is an in-memory counter of consecutive retries for the
 *      current user prompt, reset in the `input` event when a real user
 *      (not our own synthesized message) types something. Default max
 *      retries: 2. On exhaustion the extension notifies the user and
 *      stops firing until they intervene.
 *
 *   4. UI feedback: `ctx.ui.setStatus('stall-recovery', …)` shows the
 *      retry in progress; cleared when the next turn produces real work.
 *      `ctx.ui.notify(...)` on budget exhaustion so the user knows to
 *      step in.
 *
 * Pure logic (classifier, snapshot extraction, retry-message formatting,
 * sentinel constant) lives in `./lib/stall-detect.ts` so it can be
 * unit-tested under plain `node --test` without the pi runtime.
 *
 * Environment:
 *   PI_STALL_RECOVERY_DISABLED=1     skip the extension entirely
 *   PI_STALL_RECOVERY_MAX_RETRIES=N  consecutive retries per user prompt
 *                                    (default 2)
 *   PI_STALL_RECOVERY_VERBOSE=1      log each detection + retry decision
 *                                    via ctx.ui.notify (useful for
 *                                    tuning the classifier on local
 *                                    models)
 */

import { type ExtensionAPI, type ExtensionContext } from '@mariozechner/pi-coding-agent';
import {
  buildRetryMessage,
  classifyAssistant,
  hasStallMarker,
  lastAssistantSnapshot,
  STALL_MARKER,
  type StallReason,
} from '../../../lib/node/pi/stall-detect.ts';

const STATUS_KEY = 'stall-recovery';
const MAX_RETRIES_DEFAULT = 2;

export default function stallRecovery(pi: ExtensionAPI): void {
  if (process.env.PI_STALL_RECOVERY_DISABLED === '1') return;

  const maxRetries = (() => {
    const raw = process.env.PI_STALL_RECOVERY_MAX_RETRIES;
    if (!raw) return MAX_RETRIES_DEFAULT;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : MAX_RETRIES_DEFAULT;
  })();
  const verbose = process.env.PI_STALL_RECOVERY_VERBOSE === '1';

  // Per-user-prompt retry counter. Reset whenever a REAL user types
  // something new (source !== 'extension'). In-memory only: after a
  // reload mid-stall the counter resets, which is fine — the sentinel
  // marker on the last user message prevents an immediate double-fire
  // even after reload.
  let consecutiveRetries = 0;
  // Track whether we've surfaced the "budget exhausted" notice for the
  // current prompt so we don't spam it on every subsequent agent_end.
  let budgetExhaustedNotified = false;

  const clearStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, undefined as unknown as string);
  };

  pi.on('input', (event, ctx) => {
    // Only reset on real user input. Our own sendUserMessage calls fire
    // input events with source='extension'; resetting on those would
    // defeat the retry cap.
    if (event.source === 'extension') return;
    // Belt-and-suspenders: if someone or something replays our nudge via
    // interactive / rpc (e.g. user retyped the sentinel), don't reset.
    if (typeof event.text === 'string' && hasStallMarker(event.text)) return;
    consecutiveRetries = 0;
    budgetExhaustedNotified = false;
    clearStatus(ctx);
  });

  pi.on('session_start', (_event, ctx) => {
    // Fresh session: reset everything.
    consecutiveRetries = 0;
    budgetExhaustedNotified = false;
    clearStatus(ctx);
  });

  pi.on('agent_end', (event, ctx) => {
    const messages = (event as { messages?: readonly unknown[] }).messages ?? [];
    const snapshot = lastAssistantSnapshot(messages);
    if (!snapshot) return;

    const reason: StallReason | null = classifyAssistant(snapshot);
    if (!reason) {
      // Healthy turn — clear any lingering retry status and reset.
      if (consecutiveRetries > 0 || budgetExhaustedNotified) {
        consecutiveRetries = 0;
        budgetExhaustedNotified = false;
        clearStatus(ctx);
      }
      return;
    }

    // Budget check BEFORE incrementing, so max=2 means we fire twice.
    if (consecutiveRetries >= maxRetries) {
      if (!budgetExhaustedNotified) {
        budgetExhaustedNotified = true;
        const detail = reason.kind === 'error' ? `error: ${reason.error}` : 'empty response';
        ctx.ui.notify(
          `Agent stalled ${maxRetries} time(s) in a row (${detail}). Auto-retry paused — type to continue manually.`,
          'warning',
        );
        clearStatus(ctx);
      }
      return;
    }

    const attempt = consecutiveRetries + 1;

    if (verbose) {
      const detail = reason.kind === 'error' ? `error: ${reason.error}` : 'empty response';
      ctx.ui.notify(`stall-recovery: detected ${detail}, retrying (${attempt}/${maxRetries})`, 'info');
    }

    ctx.ui.setStatus(
      STATUS_KEY,
      `⟳ Auto-retrying stalled turn (${attempt}/${maxRetries})${reason.kind === 'error' ? ' — transport error' : ''}…`,
    );

    const nudge = buildRetryMessage(reason, attempt, maxRetries);

    // Increment BEFORE sending: the input event for this synthesized
    // message will fire, and we want the counter already updated when
    // it's received (though our input handler ignores source='extension'
    // anyway, this keeps the invariant robust to provider ordering).
    consecutiveRetries = attempt;

    try {
      pi.sendUserMessage(nudge, { deliverAs: 'followUp' });
    } catch (e) {
      // sendUserMessage shouldn't throw in practice, but if delivery
      // fails we clear the status so the user isn't left staring at a
      // stuck "retrying…" footer. Surface the failure so it's visible.
      clearStatus(ctx);
      ctx.ui.notify(`stall-recovery: failed to deliver retry message: ${String(e)}`, 'error');
    }
  });

  pi.on('session_shutdown', () => {
    // Nothing to persist — in-memory counters are fine to lose on
    // shutdown. Declared only so the extension has a visible lifecycle
    // hook if future changes need cleanup.
  });
}

// Re-export the sentinel so consumers (tests, composed extensions) can
// discover our marker without reaching into `./lib/`.
export { STALL_MARKER };
