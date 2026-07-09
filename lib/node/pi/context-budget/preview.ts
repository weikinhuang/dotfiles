/**
 * Pure builder for the `/context-budget [preview]` command output.
 *
 * The command dumps the exact advisory line that would ride the next
 * turn's `context` hook, together with current usage, thresholds, and
 * auto-compact state so the user can see which tone band they're in and
 * why. All of that is a pure string computation over the usage snapshot
 * and the extension's resolved options - no pi imports - so it lives here
 * and is covered by a golden-output spec.
 */

import { type BudgetOptions, type ContextUsageLike, formatBudgetLine, formatTokens } from '../context-budget.ts';

/**
 * Render the multi-line preview block shown by `/context-budget`.
 *
 * @param usage                 the current context-usage snapshot (or null/undefined when unknown)
 * @param options               the resolved min/warn/critical thresholds
 * @param autoCompactThreshold  the auto-compact edge-trigger percent, or null when disabled
 * @param compactedThisSession  whether auto-compaction has already fired this session
 */
export function buildBudgetPreview(
  usage: ContextUsageLike | null | undefined,
  options: BudgetOptions,
  autoCompactThreshold: number | null,
  compactedThisSession: boolean,
): string {
  const lines: string[] = [];

  // Header: usage + thresholds
  if (!usage || usage.percent === null || usage.tokens === null) {
    lines.push('Context usage: (unknown - typically right after compaction, before the next LLM response)');
  } else {
    const tokensLeft = Math.max(0, usage.contextWindow - usage.tokens);
    lines.push(
      `Context usage: ${Math.round(usage.percent)}% - ${formatTokens(usage.tokens)} used, ${formatTokens(tokensLeft)} left of ${formatTokens(usage.contextWindow)} window`,
    );
  }
  lines.push(
    `Thresholds: min=${options.minPercent}%, warn=${options.warnPercent}%, critical=${options.criticalPercent}%`,
  );
  if (autoCompactThreshold !== null) {
    lines.push(
      `Auto-compact: edge-triggers at ${autoCompactThreshold}% (previous turn below, current at or above)` +
        (compactedThisSession ? ' - already fired this session, waiting for usage to dip back under threshold' : ''),
    );
  } else {
    lines.push('Auto-compact: disabled (set PI_CONTEXT_BUDGET_AUTO_COMPACT_PERCENT=N to enable)');
  }
  lines.push('');

  // Preview block or "would be silent" message
  const line = formatBudgetLine(usage ?? null, options);
  if (!line) {
    const reason =
      !usage || usage.percent === null
        ? 'usage is unknown'
        : `usage ${Math.round(usage.percent)}% is below min-percent ${options.minPercent}%`;
    lines.push(`No advisory would be injected next turn (${reason}).`);
  } else {
    lines.push("Injected into the next turn's system prompt:");
    lines.push('');
    lines.push(line);
  }

  return lines.join('\n');
}
