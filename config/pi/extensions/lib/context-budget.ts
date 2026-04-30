/**
 * Pure helpers for the context-budget extension.
 *
 * No pi imports — testable under plain `node --test`.
 *
 * The extension's job is to surface the model's own context-window usage
 * INSIDE its own prompt, so weaker models don't blow through the window
 * with oversized `read`s and `rg`s. Pi already shows `N% left` in the
 * footer (via `ctx.getContextUsage()`), but the model doesn't see the
 * footer — it only sees the system prompt. This extension bridges that
 * gap with a single-line advisory appended to the system prompt each
 * turn.
 *
 * Separately, the extension can trigger compaction automatically when
 * usage crosses a configurable percent threshold — a narrower, simpler
 * version of the stock `trigger-compact.ts` example that uses percent
 * rather than raw tokens and respects the user's setup (it won't fire
 * if the extension is disabled or the threshold is 100+).
 *
 * Decision matrix:
 *
 *   - 0–50% used:          no line injected (plenty of room; don't nag)
 *   - 50–80%:              advisory line, neutral tone
 *   - 80–90%:              advisory line, "be efficient" tone
 *   - 90%+:                advisory line, "you are running out" tone,
 *                          and potentially trigger auto-compact
 *
 * The threshold bands are conservative on the low end because the whole
 * point of the extension is to put the number in front of the model WELL
 * BEFORE it becomes a problem. Waiting until 90% to speak up is too late
 * on weaker models that chain 10-read sessions together.
 */

export interface ContextUsageLike {
  /** Estimated context tokens, or null if unknown. */
  tokens: number | null;
  /** Context window size in tokens. */
  contextWindow: number;
  /** Context usage as a 0–100 percent, or null if tokens is unknown. */
  percent: number | null;
}

export interface BudgetOptions {
  /** Percent of window at or above which we inject a line. Default 50. */
  minPercent?: number;
  /** Percent at or above which the tone shifts to "be efficient". Default 80. */
  warnPercent?: number;
  /** Percent at or above which the tone shifts to "running out". Default 90. */
  criticalPercent?: number;
}

/** Human-readable compact token format: 1.2M / 45k / 380. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(1) : m.toFixed(2)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return `${Math.round(n)}`;
}

/**
 * Render the single-line advisory injected into the system prompt. Returns
 * `null` when nothing should be said — either because usage is unknown,
 * or because we're well under the minimum-percent threshold.
 *
 * The line is short by design: it competes with everything else in the
 * system prompt and a terse "N% used, X tokens left — prefer targeted
 * reads" has more signal-per-token than a paragraph.
 */
export function formatBudgetLine(usage: ContextUsageLike | null | undefined, opts: BudgetOptions = {}): string | null {
  if (!usage) return null;
  if (usage.percent === null || usage.tokens === null) return null;
  const minP = opts.minPercent ?? 50;
  const warnP = opts.warnPercent ?? 80;
  const critP = opts.criticalPercent ?? 90;
  const pct = usage.percent;
  if (pct < minP) return null;
  const tokensLeft = Math.max(0, usage.contextWindow - usage.tokens);
  const pctStr = `${Math.round(pct)}%`;
  const headroom = `${formatTokens(tokensLeft)} tokens left of ${formatTokens(usage.contextWindow)}`;
  const base = `Context: ${pctStr} used (${headroom}).`;
  if (pct >= critP) {
    return `${base} You are running out of context — finish what's essential now. Prefer targeted \`rg\` with patterns, \`read\` with \`offset\` / \`limit\`, and avoid broad reads or long bash output. Consider \`/compact\` if you need more room.`;
  }
  if (pct >= warnP) {
    return `${base} Be efficient with tool output — favor targeted \`rg\`/\`grep\` over broad reads, and \`read\` with \`offset\` / \`limit\` on large files.`;
  }
  return `${base} Prefer targeted \`rg\` with patterns over broad reads; use \`read --offset / --limit\` on large files.`;
}

/**
 * Decide whether the auto-compaction trigger should fire for the given
 * usage and threshold. Returns `true` when crossing from below-threshold
 * to at-or-above-threshold — a proper "edge trigger" so we don't fire
 * every turn while sitting above the line.
 *
 * `previousPercent` is the percent reported on the PRIOR turn (null /
 * undefined on the first turn, or immediately after compaction before
 * the next usage estimate lands). Edge-triggering protects against
 * double-compacting mid-session.
 */
export function shouldAutoCompact(
  currentPercent: number | null | undefined,
  previousPercent: number | null | undefined,
  thresholdPercent: number,
): boolean {
  if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent >= 100) return false;
  if (currentPercent === null || currentPercent === undefined) return false;
  if (currentPercent < thresholdPercent) return false;
  // Edge trigger: previous must be known AND below threshold.
  if (previousPercent === null || previousPercent === undefined) return false;
  return previousPercent < thresholdPercent;
}
