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

import { type BudgetResult, type LoreChunk } from './budget.ts';
import { type RoleplayEntry } from './store.ts';

const HEADER = '## Roleplay lore (relevant to the current turn)';

function renderChunk(chunk: LoreChunk): string {
  const constant = chunk.entry.lore?.constant ? ' (always-on)' : '';
  return `### ${chunk.entry.name}${constant}\n${chunk.body.trim()}`;
}

/**
 * Render the fired-lore block from a budget result, or `null` when nothing
 * fired (so the caller can skip injection). A trailer notes any entries
 * dropped by the char budget.
 */
export function formatLoreBlock(result: BudgetResult): string | null {
  if (result.kept.length === 0) return null;
  const parts = [HEADER, ...result.kept.map(renderChunk)];
  if (result.dropped.length > 0) {
    const names = result.dropped.map((e: RoleplayEntry) => e.name).join(', ');
    parts.push(`(lore budget reached; ${result.dropped.length} more entry(ies) not shown: ${names})`);
  }
  return parts.join('\n\n').trimEnd();
}
