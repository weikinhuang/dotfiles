/**
 * Pure relevance ranking + char-budget eviction for fired lore entries.
 *
 * No pi imports - unit-testable under `vitest`.
 *
 * Fired lore is paired with its loaded body into a {@link LoreChunk}, then
 * ranked (higher `order` first, ties broken by name) and greedily kept
 * until the next chunk would blow the char budget. At least one chunk is
 * always kept when any fired, so a too-small budget can't blank the whole
 * lorebook - it just keeps the single highest-priority entry.
 */

import { type RoleplayEntry } from './store.ts';

export interface LoreChunk {
  entry: RoleplayEntry;
  /** Body text already trimmed by the caller. */
  body: string;
}

export interface BudgetResult {
  kept: LoreChunk[];
  dropped: RoleplayEntry[];
}

/** Approximate rendered cost of a chunk: heading + body + framing newlines. */
export function chunkCost(chunk: LoreChunk): number {
  return chunk.entry.name.length + chunk.body.length + 8;
}

/** Rank fired lore: higher `order` first, then name A->Z, then id for stability. */
export function rankLore(chunks: readonly LoreChunk[]): LoreChunk[] {
  return [...chunks].sort((a, b) => {
    const oa = a.entry.lore?.order ?? 0;
    const ob = b.entry.lore?.order ?? 0;
    if (oa !== ob) return ob - oa;
    const byName = a.entry.name.localeCompare(b.entry.name);
    if (byName !== 0) return byName;
    return a.entry.id.localeCompare(b.entry.id);
  });
}

/**
 * Rank then evict to fit `charBudget`. The first (highest-priority) chunk
 * is always kept regardless of budget; subsequent chunks are dropped once
 * the running total would exceed the cap. Dropped entries are returned in
 * rank order so the caller can surface a trailer.
 */
export function selectWithinBudget(chunks: readonly LoreChunk[], charBudget: number): BudgetResult {
  const ranked = rankLore(chunks);
  const kept: LoreChunk[] = [];
  const dropped: RoleplayEntry[] = [];
  let used = 0;
  for (const chunk of ranked) {
    const cost = chunkCost(chunk);
    if (kept.length > 0 && used + cost > charBudget) {
      dropped.push(chunk.entry);
      continue;
    }
    kept.push(chunk);
    used += cost;
  }
  return { kept, dropped };
}
