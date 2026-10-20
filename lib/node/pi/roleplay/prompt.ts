/**
 * Pure renderer for the fired-lore section appended to the system prompt
 * each turn, below the `## Roleplay` cast index.
 *
 * No pi imports - unit-testable under `vitest`.
 *
 * Unlike the cast index (one line per entry, bodies fetched on demand),
 * fired lore injects full bodies: the whole point of keyword triggering is
 * that the relevant world detail is in-context without a tool call.
 */

import {
  type BudgetResult,
  formatLoreTrailer,
  LORE_BLOCK_HEADER,
  LORE_BLOCK_SEPARATOR,
  renderLoreChunk,
} from './budget.ts';

/**
 * Render the fired-lore block from a budget result, or `null` when nothing
 * fired (so the caller can skip injection). A trailer notes any entries
 * dropped by the char budget. Framing is shared with `budget.ts` so the
 * budget accounting matches the rendered size exactly.
 */
export function formatLoreBlock(result: BudgetResult): string | null {
  if (result.kept.length === 0) return null;
  const parts = [LORE_BLOCK_HEADER, ...result.kept.map(renderLoreChunk)];
  const trailer = formatLoreTrailer(result.dropped);
  if (trailer !== null) parts.push(trailer);
  return parts.join(LORE_BLOCK_SEPARATOR).trimEnd();
}
