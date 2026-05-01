/**
 * Shared token / cost / cache formatters.
 *
 * Extracted out of `config/pi/extensions/statusline.ts` so both the
 * statusline and the subagent extension render token numbers, cost, and
 * cache-hit ratios in the same style without copy/paste drift.
 *
 * Pure module — no pi imports — so it can be unit-tested under `vitest`.
 * Keep any new formatter here tight and unit-covered; every call site
 * should render the same way across the app.
 */

/**
 * SI-style token count (mirrors Claude Code's status-line convention):
 * values under 1k render as a bare integer, under 1M as `<n>k` (rounded,
 * `.<d>k` when under 10k for finer granularity), and `M` with two
 * fractional digits above 1M (one digit above 10M).
 */
export function fmtSi(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(1) : m.toFixed(2)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return `${Math.round(n)}`;
}

/** Cost in whole dollars, three-decimal precision. */
export function fmtCost(c: number): string {
  return `$${c.toFixed(3)}`;
}

/**
 * Prompt-cache hit ratio as an integer percent, or `null` when the
 * denominator is zero (nothing billed on the input side yet — no ratio
 * to report).
 */
export function cacheHitRatioPct(usage: { input: number; cacheRead: number }): number | null {
  const denom = (usage.input ?? 0) + (usage.cacheRead ?? 0);
  if (denom <= 0) return null;
  return Math.round(((usage.cacheRead ?? 0) / denom) * 100);
}

export interface TokenAggregate {
  input: number;
  cacheRead: number;
  cacheWrite?: number;
  output: number;
}

/**
 * One-line `↑in/↻cached/↓out` summary used by both the statusline (for
 * the parent turn) and the subagent extension (for child usage). Writes
 * are rendered as `/W <n>` only when non-zero because most providers
 * don't bill them. Ratio is appended as ` R N%` when available so callers
 * don't have to stitch it on themselves.
 */
export function formatUsageLine(agg: TokenAggregate, options: { includeRatio?: boolean } = {}): string {
  const writeSeg = agg.cacheWrite && agg.cacheWrite > 0 ? `/W ${fmtSi(agg.cacheWrite)}` : '';
  const core = `↑${fmtSi(agg.input)}/↻ ${fmtSi(agg.cacheRead)}${writeSeg}/↓${fmtSi(agg.output)}`;
  if (options.includeRatio) {
    const ratio = cacheHitRatioPct({ input: agg.input, cacheRead: agg.cacheRead });
    if (ratio !== null) return `${core} R ${ratio}%`;
  }
  return core;
}
