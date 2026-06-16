/**
 * Turn the user-selected file targets into an ordered, side-effect-free
 * restore plan. Each selected file becomes either a `write` (restore the
 * target blob's bytes) or a `delete` (the target state is "absent"). The
 * shell executes the plan: reading the blob for a `write`, unlinking for a
 * `delete`.
 *
 * The plan is deterministic (sorted by path) and carries the target blob
 * hash so the shell never has to re-resolve it. Files are independent, so
 * order is purely for reproducible specs / logs.
 *
 * No pi imports.
 */

import type { FileTarget } from './types.ts';

export interface RestoreAction {
  path: string;
  kind: 'write' | 'delete';
  /** sha256 of the bytes to write; present only for `kind: 'write'`. */
  sha?: string;
}

/**
 * Build the restore plan for the `selected` targets. A target whose `target`
 * state is `null` (file absent at the destination) becomes a `delete`;
 * otherwise a `write` of the target blob.
 */
export function buildRestorePlan(selected: readonly FileTarget[]): RestoreAction[] {
  const actions: RestoreAction[] = selected.map((t) =>
    t.target === null ? { path: t.path, kind: 'delete' } : { path: t.path, kind: 'write', sha: t.target },
  );
  actions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return actions;
}
