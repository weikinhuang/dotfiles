/**
 * Verify-before-claim extension for pi — flags verification claims the
 * model makes without running a verifier in the same turn.
 *
 * Generalization of the `todo` extension's completion-claim guardrail.
 * Where that one catches "I'm done" with open todos still around, this
 * catches "tests pass", "lint is clean", "the build succeeds", etc.
 * when there's no matching tool call in the current turn to back it up.
 *
 * How it works:
 *
 *   1. On `agent_end`, pull the last assistant text via
 *      `extractLastAssistantText` and scan the tail for typed claim
 *      phrases via `extractClaims`.
 *
 *   2. Walk the branch backward to the most recent user message,
 *      collecting every bash command that ran in between via
 *      `collectBashCommandsSinceLastUser`.
 *
 *   3. Partition claims into (verified, unverified) using liberal
 *      command-match patterns. A claim is verified if ANY of the turn's
 *      bash commands looks like a verifier for that claim's kind.
 *
 *   4. If `unverified.length > 0` AND the most recent user message
 *      doesn't already carry our sentinel marker (idempotency guard),
 *      inject a follow-up user message with the steer via
 *      `pi.sendUserMessage(..., { deliverAs: 'followUp' })`.
 *
 * Composes cleanly with the other `agent_end` extensions:
 *   - todo guardrail fires on a "done" sign-off with open todos.
 *   - stall-recovery fires on empty turns and errors.
 *   - this one fires on verification sign-offs without verifiers.
 *
 * All three inject messages with distinct sentinels and check for their
 * own sentinel before firing, so they never re-trigger on their own
 * nudges. They CAN fire together on the same turn if the model makes
 * multiple kinds of claim — that's fine, each reaches the model
 * separately and the model can address them independently.
 *
 * Pure logic (claim extraction, command patterns, steer formatting,
 * branch scanning) lives in `./lib/verify-detect.ts` so it can be
 * unit-tested under plain `node --test`.
 *
 * Environment:
 *   PI_VERIFY_DISABLED=1   skip the extension entirely
 *   PI_VERIFY_VERBOSE=1    emit a ctx.ui.notify on every detection +
 *                          decision. Useful for tuning the claim
 *                          regexes against a noisy model.
 */

import { type ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
  type BranchEntry,
  buildSteer,
  collectBashCommandsSinceLastUser,
  extractClaims,
  extractLastAssistantText,
  lastUserMessageHasMarker,
  partitionClaims,
} from './lib/verify-detect.ts';

/** Sentinel prepended to every steer — used for idempotency + discovery. */
const VERIFY_MARKER = '⚠ [pi-verify-before-claim]';

export default function verifyBeforeClaim(pi: ExtensionAPI): void {
  if (process.env.PI_VERIFY_DISABLED === '1') return;
  const verbose = process.env.PI_VERIFY_VERBOSE === '1';

  pi.on('agent_end', (event, ctx) => {
    const messages = (event as { messages?: readonly unknown[] }).messages ?? [];
    const text = extractLastAssistantText(messages);
    if (!text) return;

    const claims = extractClaims(text);
    if (claims.length === 0) return;

    const branch = ctx.sessionManager.getBranch() as unknown as readonly BranchEntry[];
    const commands = collectBashCommandsSinceLastUser(branch);
    const { verified, unverified } = partitionClaims(claims, commands);

    if (verbose) {
      const parts: string[] = [];
      if (verified.length > 0) parts.push(`verified=${verified.map((c) => c.kind).join(',')}`);
      if (unverified.length > 0) parts.push(`unverified=${unverified.map((c) => c.kind).join(',')}`);
      if (parts.length > 0) ctx.ui.notify(`verify-before-claim: ${parts.join(' ')}`, 'info');
    }

    if (unverified.length === 0) return;

    // Idempotency: if the previous user message already carries our
    // marker, we already steered this turn — let the model respond to
    // that nudge on its own rather than piling on.
    if (lastUserMessageHasMarker(branch, VERIFY_MARKER)) return;

    const steer = buildSteer(unverified, VERIFY_MARKER);
    if (!steer) return;

    try {
      pi.sendUserMessage(steer, { deliverAs: 'followUp' });
    } catch (e) {
      ctx.ui.notify(`verify-before-claim: failed to deliver steer: ${String(e)}`, 'error');
    }
  });
}

// Re-export the sentinel so consumers (tests, composed extensions) can
// discover our marker without reaching into `./lib/`.
export { VERIFY_MARKER };
