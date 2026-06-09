/**
 * Pure formatters for the `/context` breakdown - token counts, percents,
 * breadcrumbs, legend rows, and inline bars. No pi imports.
 *
 * Token counts reuse `fmtSi` from `token-format.ts` so `/context` renders
 * numbers the same way as the statusline and `/context-budget`.
 */

import { fmtSi } from '../token-format.ts';
import type { CategoryNode } from './types.ts';

export { fmtSi as formatTokens } from '../token-format.ts';

/** Glyphs - identical to Claude Code's `/context`. */
export const GLYPH_USED = '⛁';
export const GLYPH_PARTIAL = '⛀';
export const GLYPH_FREE = '⛶';

/**
 * Percent of `total` as a trimmed string with one decimal under 10%, else a
 * whole number. Returns `'0%'` when total is 0. Never throws.
 */
export function formatPercent(part: number, total: number): string {
  if (total <= 0 || !Number.isFinite(total)) return '0%';
  const pct = (part / total) * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** `"6.3k  3.1%"` - token count padded then percent, for legend rows. */
export function formatTokensPct(part: number, total: number): string {
  return `${fmtSi(part)}  ${formatPercent(part, total)}`;
}

/**
 * Breadcrumb of node labels joined with `" › "`, prefixed with `/context`.
 * e.g. `["System prompt", "Context files"]` → `/context › System prompt › Context files`.
 */
export function formatBreadcrumb(labels: readonly string[]): string {
  return ['/context', ...labels].join(' › ');
}

/**
 * Absolute-share suffix for a drilled node, e.g.
 * `6.3k · 3.1% of 200k window`. `windowTokens` is the whole context window.
 */
export function formatAbsoluteShare(tokens: number, windowTokens: number): string {
  return `${fmtSi(tokens)} · ${formatPercent(tokens, windowTokens)} of ${fmtSi(windowTokens)} window`;
}

/**
 * A unicode block bar of `width` cells filled proportionally to
 * `part / total`. Used in the flat (notify) report where there's no grid.
 */
export function formatBar(part: number, total: number, width = 20): string {
  if (total <= 0 || width <= 0) return ''.padEnd(Math.max(0, width), '░');
  const filled = Math.round((part / total) * width);
  const clamped = Math.max(0, Math.min(width, filled));
  return '█'.repeat(clamped) + '░'.repeat(width - clamped);
}

/**
 * Sum of a node's children tokens (0 when leaf). Useful to detect the
 * "free" slack at the root level (window - Σ children).
 */
export function childrenTotal(node: CategoryNode): number {
  if (!node.children || node.children.length === 0) return 0;
  let sum = 0;
  for (const c of node.children) sum += c.tokens;
  return sum;
}

/**
 * Compute a scroll window `[start, end)` of `total` rows that keeps `sel`
 * visible, showing at most `maxVisible` rows. Centers the selection when
 * possible, clamped to the ends. Returns the full range when everything
 * fits.
 */
export function scrollWindow(total: number, sel: number, maxVisible: number): { start: number; end: number } {
  if (maxVisible <= 0 || total <= maxVisible) return { start: 0, end: Math.max(0, total) };
  const clampedSel = Math.max(0, Math.min(total - 1, sel));
  let start = clampedSel - Math.floor(maxVisible / 2);
  start = Math.max(0, Math.min(start, total - maxVisible));
  return { start, end: start + maxVisible };
}

/** Collapse whitespace and truncate a detail string for compact display. */
export function sanitizeDetail(detail: string, max = 100): string {
  const oneLine = detail.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
