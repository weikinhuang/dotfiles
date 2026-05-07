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
 *   1. On `agent_end`, scan `event.messages` with `countTrailingStalls`
 *      — a stateless counter that walks backwards and counts consecutive
 *      stalled assistant turns since the last real user prompt. Any
 *      healthy assistant turn (text or tool call) in the window resets
 *      the count to zero, so intermediate successes inside a multi-step
 *      agent loop correctly "unspend" prior retries.
 *
 *   2. If the count is in `(0, maxRetries]` we inject a follow-up user
 *      message via `pi.sendUserMessage()` carrying a sentinel prefix.
 *      The follow-up triggers a fresh agent turn; other extensions
 *      (like `todo`) re-inject their context via `before_agent_start`
 *      on the retry automatically.
 *
 *   3. When `countTrailingStalls === maxRetries` we've already fired the
 *      maximum retries for this prompt, so we surface a one-shot notify
 *      ("Auto-retry paused — type to continue manually") and stop until
 *      the user intervenes. The `input` handler clears the one-shot
 *      flag when a real user prompt arrives.
 *
 *   4. On `context` (fires before every LLM call), we strip `thinking`
 *      blocks from any trailing stalled assistant when the pending
 *      request ends with one of our retry nudges. This breaks the
 *      extended-thinking feedback loop where the provider replays a
 *      prior thinking signature and the model resumes the same
 *      rumination that produced no output last time. See
 *      `stripThinkingFromStalledTurns` for the safety argument.
 *
 *   5. UI feedback: `ctx.ui.setStatus('stall-recovery', …)` shows the
 *      retry in progress; cleared when the next turn produces real work.
 *      `ctx.ui.notify(...)` on budget exhaustion so the user knows to
 *      step in.
 *
 * Pure logic (classifier, snapshot extraction, trailing-stall counter,
 * retry-message formatting, thinking-strip, sentinel constant) lives in
 * `./lib/stall-detect.ts` so it can be unit-tested under `vitest`
 * without the pi runtime.
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

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  buildRetryMessage,
  classifyAssistant,
  countTrailingStalls,
  hasStallMarker,
  lastAssistantSnapshot,
  STALL_MARKER,
  stripThinkingFromStalledTurns,
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

  // The retry budget itself is stateless — we recompute it from the
  // message history on every agent_end via `countTrailingStalls`. The
  // only piece we keep in memory is whether we've already surfaced the
  // "budget exhausted" notify for the current prompt, so we don't spam
  // it on every subsequent agent_end.
  let budgetExhaustedNotified = false;

  const clearStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, undefined as unknown as string);
  };

  pi.on('input', (event, ctx) => {
    // Only reset on real user input. Our own sendUserMessage calls fire
    // input events with source='extension'; resetting on those is
    // harmless (the budget is stateless) but clearing the exhausted
    // notice is wrong — wait for a real prompt.
    if (event.source === 'extension') return;
    if (typeof event.text === 'string' && hasStallMarker(event.text)) return;
    budgetExhaustedNotified = false;
    clearStatus(ctx);
  });

  pi.on('session_start', (_event, ctx) => {
    budgetExhaustedNotified = false;
    clearStatus(ctx);
  });

  pi.on('agent_end', (event, ctx) => {
    const messages = (event as { messages?: readonly unknown[] }).messages ?? [];

    // Use the last assistant snapshot only to describe the reason in UI
    // output — the decision of whether to fire is driven by the
    // trailing-stall count so we don't double-count or miss intermediate
    // successes.
    const snapshot = lastAssistantSnapshot(messages);
    if (!snapshot) return;
    const reason: StallReason | null = classifyAssistant(snapshot);

    if (!reason) {
      // Healthy final turn — clear any lingering retry status and the
      // one-shot exhausted-notify flag.
      if (budgetExhaustedNotified) {
        budgetExhaustedNotified = false;
      }
      clearStatus(ctx);
      return;
    }

    const trailing = countTrailingStalls(messages);

    // Budget exhausted: trailing stalls already include the maxRetries
    // we fired. Surface the notify once and wait for a real user.
    if (trailing >= maxRetries + 1) {
      if (!budgetExhaustedNotified) {
        budgetExhaustedNotified = true;
        const detail = reason.kind === 'error' ? `error: ${reason.error}` : 'empty response';
        ctx.ui.notify(
          `Agent stalled ${trailing} time(s) in a row (${detail}). Auto-retry paused — type to continue manually.`,
          'warning',
        );
        clearStatus(ctx);
      }
      return;
    }

    const attempt = trailing; // trailing=1 → first retry, trailing=maxRetries → last retry

    if (verbose) {
      const detail = reason.kind === 'error' ? `error: ${reason.error}` : 'empty response';
      ctx.ui.notify(`stall-recovery: detected ${detail}, retrying (${attempt}/${maxRetries})`, 'info');
    }

    ctx.ui.setStatus(
      STATUS_KEY,
      `⟳ Auto-retrying stalled turn (${attempt}/${maxRetries})${reason.kind === 'error' ? ' — transport error' : ''}…`,
    );

    const nudge = buildRetryMessage(reason, attempt, maxRetries);

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

  // Break the extended-thinking feedback loop: when the next LLM call
  // ends with one of our retry nudges, drop `thinking` blocks from the
  // trailing stalled assistant turns so the model starts a fresh
  // reasoning pass instead of resuming the rumination that emitted no
  // output last time.
  pi.on('context', (event) => {
    const messages = (event as { messages: unknown[] }).messages;
    return { messages: stripThinkingFromStalledTurns(messages) };
  });

  pi.on('session_shutdown', () => {
    // Nothing to persist — the budget is stateless and the
    // exhausted-notify flag is fine to lose on shutdown. Declared only
    // so the extension has a visible lifecycle hook if future changes
    // need cleanup.
  });
}

// Re-export the sentinel so consumers (tests, composed extensions) can
// discover our marker without reaching into `./lib/`.
export { STALL_MARKER };
