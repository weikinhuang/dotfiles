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
 *     AND the subverbs.
 *   - Level 2 (after `restore `) delegates to {@link completeSubverbs} so
 *     the `restore <#id>` value carries the verb prefix per pi's
 *     full-line-replacement rule.
 *
 * This is what lets you Tab-select a specific image instead of having to
 * read the printed list and retype its handle.
 */

import { type CompletionItem, completeSubverbs, type SubverbSpec } from '../commands/complete.ts';

/** A candidate as the commands surface it for completion: a handle + a human description. */
export interface CompletionCandidate {
  id: string;
  description: string;
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

  // Candidate handles first (they're the common case), then the verbs.
  const candidateItems: CompletionItem[] = candidates
    .filter((c) => c.id.startsWith(head))
    .map((c) => ({ value: c.id, label: c.id, description: c.description }));

  const verbItems: CompletionItem[] = Object.keys(verbs)
    .filter((v) => v.startsWith(head))
    .map((v) => ({ value: v, label: v, description: verbs[v].description }));

  const merged = [...candidateItems, ...verbItems];
  return merged.length > 0 ? merged : null;
}
