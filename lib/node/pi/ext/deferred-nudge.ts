/**
 * Shared "deferred follow-up nudge" delivery for the `agent_end`
 * extensions that inject a synthetic follow-up after a turn ends
 * (`stall-recovery`, `verify-before-claim`, `stream-watchdog`).
 *
 * All three hit the same pi lifecycle quirk: pi 0.75.4 moved `agent_end`
 * into the awaited agent lifecycle, so the handler runs while the
 * runtime still sees `isStreaming === true`. Sending synchronously there
 * routes the message through the follow-up queue, which the exiting
 * agent loop never pulls, so it surfaces as a stuck `Follow-up:` indicator
 * with no LLM call. Deferring one event-loop tick via `setImmediate`
 * lands after the loop unwinds, where `ctx.isIdle()` is true and the
 * `{ triggerTurn: true }` branch actually starts a fresh turn.
 *
 * This lives in `ext/` (not a pure module) because it imports pi's
 * `ExtensionAPI` / `ExtensionContext` types. It shares CODE, not STATE:
 * each caller keeps its own status/trace/notify side effects and passes
 * them in via callbacks so every site preserves its exact prior
 * behaviour (distinct error wording, `clearStatus` vs `trace`, and
 * whether an outer scheduling guard surfaces anything at all).
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface DeliverDeferredNudgeOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  /** `custom` message type so the nudge doesn't pollute up-arrow history. */
  customType: string;
  /** Nudge body delivered to the model. */
  content: string;
  /** Invoked after a successful `sendMessage` (e.g. a trace line). */
  onDelivered?: () => void;
  /** Invoked when the deferred `sendMessage` throws (stale ctx / torn-down session). */
  onDeliverError?: (e: unknown) => void;
  /** Invoked when scheduling the deferred tick itself throws. */
  onScheduleError?: (e: unknown) => void;
}

/**
 * Schedule the follow-up nudge on the next event-loop tick and deliver
 * it via `pi.sendMessage`, choosing `{ triggerTurn: true }` when the
 * agent is idle and `{ deliverAs: 'followUp' }` otherwise.
 *
 * Both the deferred delivery and the outer scheduling are guarded so a
 * best-effort nudge can never throw into the event loop; the caller's
 * callbacks (when provided) own any user-facing surfacing.
 */
export function deliverDeferredNudge(opts: DeliverDeferredNudgeOptions): void {
  const { pi, ctx, customType, content, onDelivered, onDeliverError, onScheduleError } = opts;
  try {
    setImmediate(() => {
      try {
        pi.sendMessage(
          { customType, content, display: true },
          ctx.isIdle() ? { triggerTurn: true } : { deliverAs: 'followUp' },
        );
        onDelivered?.();
      } catch (e) {
        onDeliverError?.(e);
      }
    });
  } catch (e) {
    onScheduleError?.(e);
  }
}
