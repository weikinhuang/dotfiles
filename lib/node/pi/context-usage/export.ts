/**
 * Pure markdown renderer for the `/context` breakdown - the `e` export and
 * the non-TUI notify fallback share it. No pi imports.
 */

import { cacheHitRatioPct } from '../token-format.ts';
import { childrenTotal, formatPercent, formatTokens, sanitizeDetail } from './format.ts';
import type { Breakdown, CategoryNode, UsageLike } from './types.ts';

/** Indented tree of `label … tokens (pct of window)`, deepest drill included. */
function renderNode(node: CategoryNode, windowTokens: number, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);
  const pct = formatPercent(node.tokens, windowTokens);
  const detail = node.detail ? `  — ${sanitizeDetail(node.detail)}` : '';
  lines.push(`${indent}- ${node.label}: ${formatTokens(node.tokens)} (${pct})${detail}`);
  for (const child of node.children ?? []) {
    renderNode(child, windowTokens, depth + 1, lines);
  }
}

function renderUsageLine(usage: UsageLike): string {
  const ratio = cacheHitRatioPct({ input: usage.input, cacheRead: usage.cacheRead });
  const parts = [
    `input ${formatTokens(usage.input)}`,
    `cacheRead ${formatTokens(usage.cacheRead)}`,
    `cacheWrite ${formatTokens(usage.cacheWrite)}`,
    `output ${formatTokens(usage.output)}`,
  ];
  if (ratio !== null) parts.push(`cache-hit ${ratio}%`);
  return parts.join(' · ');
}

/** Full markdown report. `now` is injected for deterministic tests. */
export function renderMarkdown(breakdown: Breakdown, now: Date = new Date()): string {
  const { root, contextWindow, estimatedUsed, realTokens, lastUsage } = breakdown;
  const lines: string[] = [];

  lines.push('# Context usage breakdown');
  lines.push('');
  const model = breakdown.modelId
    ? `${breakdown.modelId}${breakdown.provider ? ` (${breakdown.provider})` : ''}`
    : 'unknown model';
  lines.push(`- Model: ${model}`);
  lines.push(`- Context window: ${formatTokens(contextWindow)}`);
  const hasReal = realTokens !== null && realTokens > 0;
  if (hasReal) {
    lines.push(`- Real usage (provider): ${formatTokens(realTokens)} (${formatPercent(realTokens, contextWindow)})`);
  } else {
    lines.push('- Real usage (provider): unknown (no assistant turn with provider usage yet)');
  }
  lines.push(
    `- Estimated used (Σ categories): ${formatTokens(estimatedUsed)} (${formatPercent(estimatedUsed, contextWindow)})`,
  );
  const free = Math.max(0, contextWindow - childrenTotal(root));
  lines.push(`- Free space: ${formatTokens(free)} (${formatPercent(free, contextWindow)})`);
  if (lastUsage) lines.push(`- Last turn usage: ${renderUsageLine(lastUsage)}`);
  lines.push(`- Generated: ${now.toISOString()}`);
  lines.push('');
  lines.push('> Per-category numbers are chars/4 estimates; the provider total above is authoritative.');
  lines.push('');
  lines.push('## Breakdown');
  lines.push('');
  for (const child of root.children ?? []) {
    renderNode(child, contextWindow, 0, lines);
  }
  if (free > 0) lines.push(`- Free space: ${formatTokens(free)} (${formatPercent(free, contextWindow)})`);
  lines.push('');
  return lines.join('\n');
}

/** A timestamped default export filename, e.g. `context-usage-2026-…Z.md`. */
export function exportFilename(now: Date = new Date()): string {
  return `context-usage-${now.toISOString().replace(/[:.]/g, '-')}.md`;
}
