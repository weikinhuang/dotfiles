/**
 * Block reason for an unknown bash command when no approval UI exists
 * (headless `pi -p`, RPC without UI, or a subagent child with no parent
 * prompt bridge).
 *
 * The reason is what the model reads as the tool result. The old text
 * ("Add a rule via /bash-allow …") addressed the operator, which a small
 * model reads as "fix something and try again": in one headless run
 * qwen3-8-27b resubmitted the same blocked `ai-fetch-web search` ~270
 * times. Lead with an explicit "this is final, do not retry" for the
 * model and keep the operator hint, clearly labelled, at the end.
 */
export function buildNoUiDenyReason(unknown: readonly string[], userRulesPath: string): string {
  return (
    `No UI available for approval. Unknown command(s):\n  ${unknown.join('\n  ')}\n` +
    'This session cannot approve new commands, so this command - and variations of it (different flags, quoting, ' +
    'paths, or redirects) - will be blocked again. Do not retry it. Continue without it: use a different tool or an ' +
    'already-allowed command, answer from what you have, or tell the user the command needs approval.\n' +
    `(For the user: add a rule via /bash-allow or by editing ${userRulesPath}, ` +
    'or set PI_BASH_PERMISSIONS_DEFAULT=allow.)'
  );
}
