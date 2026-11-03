/** Pure search, deduplication, and presentation-only filtering for project history. */
import type { PromptHistoryEntry } from './cross-session-history.ts';
import { fuzzyMatch } from './fuzzy-match.ts';

export interface HistorySearchItem {
  entry: PromptHistoryEntry;
  score: number;
  /** Match positions in the complete, untouched prompt. */
  indices: number[];
  snippet: { text: string; indices: number[]; lineNumber: number };
}

/** Keep the newest occurrence's metadata while remembering any opener usage.
 * Unknown opener status remains unknown unless an occurrence is a known opener. */
export function dedupHistoryEntries(entries: readonly PromptHistoryEntry[]): PromptHistoryEntry[] {
  const byPrompt = new Map<string, PromptHistoryEntry>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    const existing = byPrompt.get(entry.prompt);
    if (!existing) byPrompt.set(entry.prompt, { ...entry });
    else if (existing.isOpener === true || entry.isOpener === true) existing.isOpener = true;
    else if (entry.isOpener === undefined) existing.isOpener = undefined;
  }
  return [...byPrompt.values()];
}

/** Deliberately narrow: short answers and substantive instructions stay visible. */
export function isContinuationPrompt(prompt: string): boolean {
  return /^(?:please\s+)?(?:continue|go\s+on|keep\s+going|proceed|carry\s+on)[.!…]*$/iu.test(prompt.trim());
}

function snippetFor(prompt: string, indices: number[]): HistorySearchItem['snippet'] {
  const firstMatch = indices[0] ?? 0;
  const start = firstMatch > 0 ? prompt.lastIndexOf('\n', firstMatch - 1) + 1 : 0;
  const end = prompt.indexOf('\n', firstMatch);
  return {
    text: prompt.slice(start, end === -1 ? undefined : end),
    indices: indices.filter((index) => index >= start && (end === -1 || index < end)).map((index) => index - start),
    lineNumber: prompt.slice(0, start).split('\n').length,
  };
}

export function searchHistoryEntries(
  entries: readonly PromptHistoryEntry[],
  query: string,
  showContinuations = false,
): { items: HistorySearchItem[]; hiddenCount: number } {
  const items: HistorySearchItem[] = [];
  let hiddenCount = 0;
  for (const entry of entries) {
    if (!showContinuations && entry.isOpener === false && isContinuationPrompt(entry.prompt)) {
      hiddenCount++;
      continue;
    }
    let match = fuzzyMatch(query, entry.prompt);
    if (!match) continue;
    // A greedy full-text match may start in an unrelated earlier line even
    // when a later line contains the exact query. Prefer the strongest local
    // match, retaining the full-text fallback for genuinely cross-line queries.
    if (query.length > 0 && entry.prompt.includes('\n')) {
      let offset = 0;
      for (const line of entry.prompt.split('\n')) {
        const local = fuzzyMatch(query, line);
        if (local && local.score > match.score) {
          match = { score: local.score, indices: local.indices.map((index) => offset + index) };
        }
        offset += line.length + 1;
      }
    }
    items.push({ entry, ...match, snippet: snippetFor(entry.prompt, match.indices) });
  }
  // Stable sorting preserves recency when scores tie.
  if (query.length > 0) items.sort((a, b) => b.score - a.score);
  return { items, hiddenCount };
}
