/**
 * Predicate shared by every `pi.on('input', …)` handler that wants to
 * distinguish a brand-new user turn from a same-turn signal.
 *
 * Pi 0.77.0 (`InputEvent.streamingBehavior`, PR #5107) lets handlers
 * tell apart three input shapes that previously all looked identical
 * except for the `source` field:
 *
 *   - source='interactive' / 'rpc' with `streamingBehavior` absent
 *       → genuine idle prompt: the user typed while the agent was
 *         idle, this starts a new logical turn.
 *   - source='interactive' / 'rpc' with `streamingBehavior` set to
 *       `"steer"` or `"followUp"` → the user queued a message while
 *         the agent was already streaming. Same logical turn from the
 *         model's perspective: the queued text is delivered between
 *         tool calls (`steer`) or after the in-flight turn drains
 *         (`followUp`).
 *   - source='extension' → another extension synthesized the message
 *         (stall-recovery's retry nudge, loop-breaker's steer, etc.).
 *         Also same logical turn; the model is still "thinking through"
 *         whatever the user originally asked.
 *
 * Handlers that reset per-turn budgets (`stream-watchdog` retry counter,
 * `read-reread-detector` turn number) should only reset when this
 * returns `true`. Reading `streamingBehavior` is backward-safe: on
 * pre-0.77 pi the field is `undefined`, which maps to "fresh idle
 * prompt", matching the legacy behavior.
 *
 * Pure module - no pi imports - so it's unit-testable. The input shape
 * uses a structural type so callers don't need to depend on pi's
 * runtime `InputEvent` interface.
 */

/**
 * Structural subset of pi's `InputEvent` that this predicate inspects.
 * Both fields are optional so the predicate stays robust on older pi
 * builds (where `streamingBehavior` doesn't exist) and on synthetic
 * events used in tests.
 */
export interface FreshPromptInput {
  source?: string;
  streamingBehavior?: string;
}

/**
 * Return `true` when `event` represents a genuine fresh idle user
 * prompt - i.e. a real user / RPC input that arrived while the agent
 * was idle, starting a new logical turn.
 *
 * Returns `false` for:
 *   - extension-synthesized messages (`source === 'extension'`)
 *   - queued mid-stream steers / follow-ups (`streamingBehavior` set)
 */
export function isFreshUserPrompt(event: FreshPromptInput): boolean {
  if (event.source === 'extension') return false;
  if (event.streamingBehavior) return false;
  return true;
}
