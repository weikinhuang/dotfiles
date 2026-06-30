/**
 * Argument completion for the context-edit commands.
 *
 * No pi imports - testable under `vitest` without the runtime.
 *
 * The three commands (`/context-trim`, `/context-edit`,
 * `/context-collapse`) take EITHER a candidate handle (`img1`, `tool3`,
 * `msg2`) as a positional argument OR one of the management subverbs
 * (`list` / `restore <#id>` / `clear`). So their completion is a hybrid:
 *
 *   - Level 1 offers both the live candidate handles (each described by
 *     its size + snippet so you can pick the right one from the menu)
 *     AND the subverbs. Handles match by id prefix (`msg4`) OR a fuzzy
 *     subsequence over the candidate's content (`auth` finds the message
 *     that mentions auth), so a long session is searchable by what a
 *     message says, not just its ordinal.
 *   - Level 2 (after `restore `) delegates to {@link completeSubverbs} so
 *     the `restore <#id>` value carries the verb prefix per pi's
 *     full-line-replacement rule.
 *
 * This is what lets you Tab-select a specific image instead of having to
 * read the printed list and retype its handle.
 */

import { type CompletionItem, completeSubverbs, type SubverbSpec } from '../commands/complete.ts';
import { fuzzyMatch } from '../fuzzy-match.ts';

/**
 * Minimum query length before fuzzy content matching kicks in. Below this,
 * a token is treated as id-prefix / verb navigation only (so `re` cleanly
 * means the `restore` verb, not "any message whose body has r…e"). A
 * single or double char fuzzy-matches almost everything and floods the
 * menu; real content searches are longer.
 */
const MIN_FUZZY_LEN = 3;

/** A candidate as the commands surface it for completion: a handle + a human description. */
export interface CompletionCandidate {
  id: string;
  description: string;
  /**
   * Longer content excerpt for fuzzy matching (falls back to
   * {@link description} when absent). Lets `/context-edit auth` find a
   * message by its body, not just its `msgN` handle.
   */
  search?: string;
}

/**
 * Complete a context-edit command at every token position.
 *
 * `candidates` is the live, ranked candidate list (heaviest first); its
 * order is preserved in the menu. `verbs` is the management subverb spec
 * (`list` / `restore` / `clear`). Returns `null` when nothing matches.
 */
export function completeCandidatesOrVerbs(
  prefix: string,
  candidates: readonly CompletionCandidate[],
  verbs: SubverbSpec,
): CompletionItem[] | null {
  const parts = prefix.split(/\s+/);

  // Level 2+: a verb has been chosen and we're completing its argument
  // (e.g. `restore <#id>`). Delegate so the verb prefix survives.
  if (parts.length > 1) {
    return completeSubverbs(prefix, verbs);
  }

  const head = parts[0] ?? '';

  const toItem = (c: CompletionCandidate): CompletionItem => ({
    value: c.id,
    label: c.id,
    description: c.description,
  });

  // Verbs are matched by id prefix only (never fuzzy on content).
  const verbItems: CompletionItem[] = Object.keys(verbs)
    .filter((v) => v.startsWith(head))
    .map((v) => ({ value: v, label: v, description: verbs[v].description }));

  // Bare command: every candidate in caller order, then the verbs.
  if (head === '') {
    const merged = [...candidates.map(toItem), ...verbItems];
    return merged.length > 0 ? merged : null;
  }

  // Candidate handles: id-prefix hits first, preserving caller order (so
  // `msg` lists msg1, msg2, … in document order). Then fuzzy-on-content
  // hits ranked by match score, skipping any already shown by prefix - this
  // is what makes a 500-entry session searchable by message text.
  const prefixIds = new Set<string>();
  const prefixItems: CompletionItem[] = [];
  for (const c of candidates) {
    if (c.id.startsWith(head)) {
      prefixItems.push(toItem(c));
      prefixIds.add(c.id);
    }
  }

  const fuzzy: { item: CompletionItem; score: number; seq: number }[] = [];
  if (head.length >= MIN_FUZZY_LEN) {
    candidates.forEach((c, seq) => {
      if (prefixIds.has(c.id)) return;
      const match = fuzzyMatch(head, `${c.id} ${c.search ?? c.description}`);
      if (match) fuzzy.push({ item: toItem(c), score: match.score, seq });
    });
    fuzzy.sort((a, b) => b.score - a.score || a.seq - b.seq);
  }

  const merged = [...prefixItems, ...fuzzy.map((f) => f.item), ...verbItems];
  return merged.length > 0 ? merged : null;
}
