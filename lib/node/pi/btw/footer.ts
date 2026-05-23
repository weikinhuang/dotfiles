/**
 * One-line footer rendered under the side-question answer. Tells the
 * user (a) which model actually answered, (b) whether prompt caching
 * engaged, (c) how much the side question cost - and reminds them the
 * Q&A is ephemeral.
 *
 * Pure module - no pi runtime. Token + duration formatters are kept
 * here (rather than imported from the statusline extension) so this
 * module stays self-contained and unit-testable.
 */

export interface BtwFooterStats {
  /** Display name of the model that answered. */
  model: string;
  /** Total tokens consumed by the side-question call. */
  totalTokens?: number;
  /** Cache-read tokens - helps confirm prompt caching engaged. */
  cacheReadTokens?: number;
  /** Output tokens emitted by the model. */
  outputTokens?: number;
  /** Total USD cost for this call. */
  costUsd?: number;
  /** Wall-clock duration of the call, in milliseconds. */
  durationMs?: number;
}

/**
 * Format a token count the way the statusline does: `1.2k`, `45k`,
 * `1.23M`. Small values render as bare integers. Kept here (rather than
 * imported from the statusline extension) so this module stays pi-free
 * for unit testing.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Format a millisecond duration as `450ms`, `1.2s`, or `34s`. Kept in
 * the same compact style as `formatTokens` so the footer reads like a
 * single coherent line.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * One-line footer rendered under the side-question answer. Shows just
 * enough for the user to verify (a) which model actually answered, (b)
 * whether prompt caching engaged, (c) how much this little question
 * cost them. Missing fields are silently omitted so the line stays
 * compact.
 */
export function formatFooter(stats: BtwFooterStats): string {
  const parts: string[] = [`model: ${stats.model}`];
  if (typeof stats.totalTokens === 'number' && Number.isFinite(stats.totalTokens)) {
    parts.push(`${formatTokens(stats.totalTokens)} tokens`);
  }
  if (
    typeof stats.cacheReadTokens === 'number' &&
    Number.isFinite(stats.cacheReadTokens) &&
    stats.cacheReadTokens > 0
  ) {
    parts.push(`${formatTokens(stats.cacheReadTokens)} cached`);
  }
  if (typeof stats.outputTokens === 'number' && Number.isFinite(stats.outputTokens)) {
    parts.push(`${formatTokens(stats.outputTokens)} out`);
  }
  if (typeof stats.costUsd === 'number' && Number.isFinite(stats.costUsd) && stats.costUsd > 0) {
    parts.push(`$${stats.costUsd.toFixed(4)}`);
  }
  if (typeof stats.durationMs === 'number' && Number.isFinite(stats.durationMs) && stats.durationMs >= 0) {
    parts.push(formatDuration(stats.durationMs));
  }
  parts.push('ephemeral');
  return `[${parts.join(' · ')}]`;
}
