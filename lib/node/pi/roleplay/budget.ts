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

/** Heading line of the fired-lore block rendered by `formatLoreBlock` in `prompt.ts`. */
export const LORE_BLOCK_HEADER = '## Roleplay lore (relevant to the current turn)';
/** Separator between the header, each chunk, and the trailer. */
export const LORE_BLOCK_SEPARATOR = '\n\n';

/** Render one kept chunk as `### {name}{ (always-on)}\n{body}`. */
export function renderLoreChunk(chunk: LoreChunk): string {
  const constant = chunk.entry.lore?.constant ? ' (always-on)' : '';
  return `### ${chunk.entry.name}${constant}\n${chunk.body.trim()}`;
}

/** Trailer noting entries dropped by the budget, or `null` when none were. */
export function formatLoreTrailer(dropped: readonly RoleplayEntry[]): string | null {
  if (dropped.length === 0) return null;
  const names = dropped.map((e) => e.name).join(', ');
  return `(lore budget reached; ${dropped.length} more entry(ies) not shown: ${names})`;
}

/**
 * Rendered cost of a chunk inside the lore block: the rendered chunk plus
 * the blank-line separator that joins it to the preceding block. Every
 * chunk (including the first) follows something - the header or an earlier
 * chunk - so the separator is always paid. The header itself (and the
 * dropped-entries trailer, when present) is charged once by
 * {@link selectWithinBudget}, so the whole block fits `charBudget` except
 * when the always-kept top entry alone exceeds it.
 */
export function chunkCost(chunk: LoreChunk): number {
  return LORE_BLOCK_SEPARATOR.length + renderLoreChunk(chunk).length;
}

/** Cost of the trailer for `dropped` (separator + text), or 0 when nothing dropped. */
function trailerCost(dropped: readonly RoleplayEntry[]): number {
  const trailer = formatLoreTrailer(dropped);
  return trailer === null ? 0 : LORE_BLOCK_SEPARATOR.length + trailer.length;
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

/** Options for {@link selectWithinBudget}. */
export interface BudgetOptions {
  /** Header charge (default `LORE_BLOCK_HEADER.length`). `0` = no header, so the first chunk pays no separator. */
  headerChars?: number;
  /** Render one chunk exactly as it is delivered (default {@link renderLoreChunk}, the keyword-lore block shape). */
  render?: (chunk: LoreChunk) => string;
  /** Charge (and make room for) the dropped-entries trailer (default `true`). Pass `false` when none is rendered. */
  trailer?: boolean;
}

/**
 * Rank then evict to fit `charBudget`, measured against the full rendered
 * block: header + `render`ed chunks joined by {@link LORE_BLOCK_SEPARATOR}
 * (+ the dropped-entries trailer unless `opts.trailer === false`). The
 * first (highest-priority) chunk is always kept regardless of budget;
 * later chunks are dropped once the running total would exceed the cap. If
 * the resulting trailer then overflows, the lowest-ranked kept chunks are
 * evicted (never the first) until it fits. A separator is charged only
 * where one is rendered (after the header, or between chunks). Dropped
 * entries are returned in rank order so the caller can surface a trailer.
 */
export function selectWithinBudget(
  chunks: readonly LoreChunk[],
  charBudget: number,
  opts: BudgetOptions = {},
): BudgetResult {
  const ranked = rankLore(chunks);
  const rankOf = new Map(ranked.map((c, i) => [c.entry.id, i]));
  const render = opts.render ?? renderLoreChunk;
  const header = opts.headerChars ?? LORE_BLOCK_HEADER.length;
  const withTrailer = opts.trailer ?? true;
  // A chunk pays the separator iff something (the header or an earlier chunk) precedes it.
  const cost = (chunk: LoreChunk, preceded: boolean): number =>
    (preceded ? LORE_BLOCK_SEPARATOR.length : 0) + render(chunk).length;
  const kept: LoreChunk[] = [];
  let dropped: RoleplayEntry[] = [];
  let used = header;
  for (const chunk of ranked) {
    const c = cost(chunk, header > 0 || kept.length > 0);
    if (kept.length > 0 && used + c > charBudget) {
      dropped.push(chunk.entry);
      continue;
    }
    kept.push(chunk);
    used += c;
  }
  if (!withTrailer) return { kept, dropped };
  while (dropped.length > 0 && kept.length > 1 && used + trailerCost(dropped) > charBudget) {
    const evicted = kept.pop();
    if (!evicted) break;
    // Never the first kept chunk, so it was always preceded by a separator.
    used -= cost(evicted, true);
    dropped = [...dropped, evicted.entry].toSorted((a, b) => (rankOf.get(a.id) ?? 0) - (rankOf.get(b.id) ?? 0));
  }
  return { kept, dropped };
}
