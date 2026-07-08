/**
 * Pure builders for the iteration-loop guardrail nudge messages.
 *
 * The extension shell (`config/pi/extensions/iteration-loop.ts`) owns
 * the delivery (`pi.sendMessage`) and the trigger logic; these helpers
 * only assemble the exact follow-up message text so it stays testable
 * and the marker sentinel lives in one place per nudge.
 *
 * Pure module - no pi imports.
 */

/** Build the strict edit-without-check nudge follow-up message. */
export function buildStrictEditNudge(opts: { marker: string; artifact: string; edits: number; task: string }): string {
  return (
    `${opts.marker} You've edited the declared artifact ` +
    `\`${opts.artifact}\` ` +
    `${opts.edits} time(s) without running the check. ` +
    `Call \`check run task=${opts.task}\` now to verify the changes ` +
    `against the rubric before claiming anything about the artifact. ` +
    `If you're mid-edit and the next edit is atomic, make it, then run the check.`
  );
}

/** Build the claim nudge follow-up message. */
export function buildClaimNudge(opts: { marker: string; matchedSource: string; task: string }): string {
  return (
    `${opts.marker} You claimed the artifact is correct (matched: \`${opts.matchedSource}\`), ` +
    `but you haven't run \`check run task=${opts.task}\` this turn. ` +
    `Either run the check to confirm, or retract the claim. The iteration-loop contract is: ` +
    `no "looks right / done / matches spec" without a passing verdict in the same turn.`
  );
}
