/**
 * Pure argument-completion spec for the `/rewind` command, importable by
 * both the extension shell (for `getArgumentCompletions`) and its
 * command-surface spec (so the completion can be asserted without the pi
 * runtime). Built over the shared `completePositional` helper.
 *
 * `/rewind` takes either the terminal verb `list` or a checkpoint anchor
 * entry id - all single-token positionals - so a positional completion that
 * offers `list` plus the known anchor ids is the right shape.
 *
 * No pi imports.
 */

import { completePositional, type CompletionItem } from '../commands/complete.ts';

/**
 * Completion items for `/rewind <prefix>`: the `list` verb plus every known
 * checkpoint anchor entry id, filtered by `prefix`. `anchorIds` is snapshotted
 * by the shell on `session_start` (completions receive no `ctx`). Returns
 * `null` when nothing matches.
 */
export function rewindCompletions(prefix: string, anchorIds: readonly string[]): CompletionItem[] | null {
  return completePositional(prefix, () => [
    { label: 'list', description: 'List message checkpoints' },
    ...anchorIds.map((id) => ({ label: id, description: 'Restore files to this checkpoint anchor' })),
  ]);
}
