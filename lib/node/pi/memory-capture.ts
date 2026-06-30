/**
 * Pure helpers for the memory extension's "capture-assist" nudge.
 *
 * No pi imports - unit-testable under `vitest`.
 *
 * ## What the extension does (Depth A - timing nudge only)
 *
 * Pi fires `session_before_compact` when it is about to summarize the
 * conversation away - the moment any durable fact that surfaced
 * mid-session (a preference, a correction, a project decision, an
 * external pointer) is at risk of being lost if it was never `memory
 * save`d. That event can only cancel/replace the compaction, not inject
 * context, so the extension ARMS a one-shot flag there and the next
 * `context` hook splices this SHORT reminder into the turn as a
 * `<system-reminder>` - reaching the model itself, not just the UI.
 *
 * This is purely a TIMING prompt - the model already carries the
 * `memory-first` skill describing *what* to save. It does NOT analyze
 * the transcript or propose candidates (that is the deferred Depth B).
 *
 * ## Nag-fatigue gating
 *
 * A reminder on *every* compaction would be noise. The predicate below
 * suppresses the nudge unless there is plausibly something unsaved to
 * capture: there must have been at least one user turn since the last
 * successful `memory save` this session. A fresh save resets the
 * counter, so back-to-back compactions with no intervening user
 * activity stay quiet. The nudge is also suppressed entirely when
 * memory can't be written (read-only) or the feature is disabled.
 */

/**
 * Closure-state snapshot the extension feeds to {@link shouldNudgeCapture}.
 * The extension tracks `userTurnsSinceLastSave` by incrementing on each
 * user submit and resetting to `0` on every successful `memory save`.
 */
export interface CaptureNudgeState {
  /**
   * User turns (submits) observed since the last successful save this
   * session. `0` means either nothing has happened yet or the most
   * recent action was a save - in both cases there is nothing fresh to
   * capture, so we stay quiet.
   */
  userTurnsSinceLastSave: number;
  /** `PI_MEMORY_READONLY=1` - saves are blocked, so a nudge is pointless. */
  readOnly: boolean;
  /** `PI_MEMORY_DISABLE_CAPTURE=1` - the capture-assist nudge is turned off. */
  disabled: boolean;
}

/**
 * The one-shot reminder spliced into the turn after a compaction.
 * Deliberately short (a timing nudge, not policy) and stable so tests can
 * pin it. Mentions the concrete durable categories so the model knows what
 * "worth keeping" means without re-reading the whole skill.
 */
export const CAPTURE_NUDGE =
  'The conversation was just compacted, which can drop earlier detail. ' +
  'If anything durable surfaced this session (a user preference, a correction, ' +
  'a project decision, an external pointer) that you have not `memory save`d yet, ' +
  'recall and save it now so it survives.';

/**
 * Decide whether to surface the capture-assist nudge before compaction.
 *
 * Nudge only when ALL hold:
 *   - capture-assist is enabled (`!disabled`), and
 *   - memory is writable (`!readOnly`), and
 *   - there has been at least one user turn since the last save
 *     (`userTurnsSinceLastSave > 0`) - i.e. there is plausibly
 *     something unsaved to capture.
 *
 * Otherwise stay quiet. Pure + deterministic so the extension's only
 * job is to keep `userTurnsSinceLastSave` accurate.
 */
export function shouldNudgeCapture(state: CaptureNudgeState): boolean {
  if (state.disabled) return false;
  if (state.readOnly) return false;
  return state.userTurnsSinceLastSave > 0;
}
