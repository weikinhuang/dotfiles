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
 *      command-match patterns PLUS any user `commandSatisfies` rules
 *      loaded from the config files (see below). A claim is verified
 *      if ANY of the turn's bash commands looks like a verifier for
 *      that claim's kind.
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
 * Per-project / per-user config (JSONC, all optional) at
 * `~/.pi/agent/verify-before-claim.json` and
 * `<cwd>/.pi/verify-before-claim.json`:
 *
 *   {
 *     "commandSatisfies": [
 *       { "pattern": "^\\./dev/lint\\.sh\\b",
 *         "kinds": ["lint-clean", "format-clean"] },
 *       { "pattern": "^make\\s+check\\b",
 *         "kinds": ["tests-pass", "lint-clean", "types-check"] }
 *     ]
 *   }
 *
 * Rules augment (don't replace) the built-in matchers, and the two
 * config files stack (global first, project appended).
 *
 * Pure logic (claim extraction, command patterns, steer formatting,
 * branch scanning, config loader) lives in `./lib/verify-detect.ts`
 * so it can be unit-tested under `vitest`.
 *
 * Environment:
 *   PI_VERIFY_DISABLED=1     skip the extension entirely
 *   PI_VERIFY_VERBOSE=1      emit a ctx.ui.notify on every detection +
 *                            decision. Useful for tuning the claim
 *                            regexes against a noisy model.
 *   PI_VERIFY_TRACE=<path>   append one line per agent_end decision to
 *                            <path>. Useful in -p / RPC modes where
 *                            ctx.ui.notify is silent.
 */

import { appendFileSync } from 'node:fs';

import { type ExtensionAPI, type ExtensionContext } from '@mariozechner/pi-coding-agent';

import {
  type BranchEntry,
  buildSteer,
  collectBashCommandsSinceLastUser,
  type CompiledSatisfyRule,
  type ConfigWarning,
  extractClaims,
  extractLastAssistantText,
  lastUserMessageHasMarker,
  loadSatisfyRules,
  partitionClaims,
} from '../../../lib/node/pi/verify-detect.ts';

/** Sentinel prepended to every steer — used for idempotency + discovery. */
const VERIFY_MARKER = '⚠ [pi-verify-before-claim]';

export default function verifyBeforeClaim(pi: ExtensionAPI): void {
  if (process.env.PI_VERIFY_DISABLED === '1') return;
  const verbose = process.env.PI_VERIFY_VERBOSE === '1';
  const tracePath = process.env.PI_VERIFY_TRACE;

  const trace = (msg: string): void => {
    if (!tracePath) return;
    try {
      appendFileSync(tracePath, `[verify-before-claim] ${msg}\n`, 'utf8');
    } catch {
      /* diagnostics must never break a turn */
    }
  };

  let cachedRules: CompiledSatisfyRule[] = [];
  let cachedWarnings: ConfigWarning[] = [];
  const notifiedWarnings = new Set<string>();

  const loadConfig = (cwd: string): void => {
    const result = loadSatisfyRules(cwd);
    cachedRules = result.rules;
    cachedWarnings = result.warnings;
    trace(`config loaded: ${cachedRules.length} rule(s), ${cachedWarnings.length} warning(s)`);
  };

  const surfaceWarnings = (ctx: ExtensionContext): void => {
    for (const w of cachedWarnings) {
      const key = `${w.path}:${w.error}`;
      if (notifiedWarnings.has(key)) continue;
      notifiedWarnings.add(key);
      ctx.ui.notify(`verify-before-claim: ${w.path}: ${w.error}`, 'warning');
    }
  };

  pi.on('session_start', (_event, ctx) => {
    cachedRules = [];
    cachedWarnings = [];
    notifiedWarnings.clear();
    loadConfig(ctx.cwd);
    surfaceWarnings(ctx);
  });

  pi.on('agent_end', (event, ctx) => {
    const messages = (event as { messages?: readonly unknown[] }).messages ?? [];
    const text = extractLastAssistantText(messages);
    if (!text) {
      trace('skip: no assistant text (aborted or empty)');
      return;
    }

    const claims = extractClaims(text);
    if (claims.length === 0) {
      trace('no-claims');
      return;
    }

    const branch = ctx.sessionManager.getBranch() as unknown as readonly BranchEntry[];
    const commands = collectBashCommandsSinceLastUser(branch);
    const { verified, unverified } = partitionClaims(claims, commands, cachedRules);

    if (verbose) {
      const parts: string[] = [];
      if (verified.length > 0) parts.push(`verified=${verified.map((c) => c.kind).join(',')}`);
      if (unverified.length > 0) parts.push(`unverified=${unverified.map((c) => c.kind).join(',')}`);
      if (parts.length > 0) ctx.ui.notify(`verify-before-claim: ${parts.join(' ')}`, 'info');
    }
    trace(
      `claims=[${claims.map((c) => c.kind).join(',')}] ` +
        `commands=${commands.length} ` +
        `cmd0=${JSON.stringify(commands[0] ?? '')} ` +
        `verified=[${verified.map((c) => c.kind).join(',')}] ` +
        `unverified=[${unverified.map((c) => c.kind).join(',')}] ` +
        `extras=${cachedRules.length}`,
    );

    if (unverified.length === 0) return;

    // Idempotency: if the previous user message already carries our
    // marker, we already steered this turn — let the model respond to
    // that nudge on its own rather than piling on.
    if (lastUserMessageHasMarker(branch, VERIFY_MARKER)) {
      trace('skip: previous user message already carries marker');
      return;
    }

    const steer = buildSteer(unverified, VERIFY_MARKER);
    if (!steer) return;

    try {
      pi.sendUserMessage(steer, { deliverAs: 'followUp' });
      trace(`steered kinds=[${unverified.map((c) => c.kind).join(',')}]`);
    } catch (e) {
      ctx.ui.notify(`verify-before-claim: failed to deliver steer: ${String(e)}`, 'error');
      trace(`deliver-failed: ${String(e)}`);
    }
  });
}

// Re-export the sentinel so consumers (tests, composed extensions) can
// discover our marker without reaching into `./lib/`.
export { VERIFY_MARKER };
