/**
 * Block reason for an unknown bash command when no approval UI exists
 * (headless `pi -p`, RPC without UI, or a subagent child with no parent
 * prompt bridge), plus the operator hint that goes to stderr instead.
 *
 * The reason is what the model reads as the tool result. The old text
 * ("Add a rule via /bash-allow …") addressed the operator, which a small
 * model reads as "fix something and try again": in one headless run
 * qwen3-8-27b resubmitted the same blocked `ai-fetch-web search` ~270
 * times. A later version kept a labelled "(For the user: …)" line with
 * the rules-file path and `PI_BASH_PERMISSIONS_DEFAULT=allow`; a
 * qwen3-6-35b-a3b run then tried `export PI_BASH_PERMISSIONS_DEFAULT=allow`
 * and `write` on that exact path. So the model-facing text names no
 * bypass at all, and the operator hint goes to stderr, which the model
 * never sees.
 */
export function buildNoUiDenyReason(unknown: readonly string[]): string {
  return (
    `No UI available for approval. Unknown command(s):\n  ${unknown.join('\n  ')}\n` +
    'This session cannot approve new commands, so this command - and variations of it (different flags, quoting, ' +
    'paths, or redirects) - will be blocked again. Do not retry it, and do not try to change the permission ' +
    'settings. Continue without it: use a different tool or an already-allowed command, answer from what you have, ' +
    'or tell the user the command needs approval.'
  );
}

/** One-line stderr hint for the operator of a headless session. */
export function buildNoUiOperatorHint(userRulesPath: string): string {
  return (
    '[bash-permissions] blocked unapproved command(s) in a session without an approval UI. ' +
    `Allow them with /bash-allow, by editing ${userRulesPath}, or with PI_BASH_PERMISSIONS_DEFAULT=allow.`
  );
}
