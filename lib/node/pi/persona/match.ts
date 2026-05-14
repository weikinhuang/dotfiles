/**
 * Path-string membership test for mode `writeRoots`.
 *
 * Per `plans/pi-mode-extension.md` (D8): operate on path strings only.
 * Symlink targets are NOT followed — the link path is what matters.
 * This is the lock that keeps mode boundaries predictable; do not
 * "fix" by adding `realpath` without a deliberate plan revision.
 *
 * The trailing-slash convention defends against the prefix trap:
 * `/repo/plans-old/foo` must NOT count as inside `/repo/plans/`.
 * If a root lacks a trailing slash, we append one before the prefix
 * check so siblings are correctly excluded.
 */

import { resolve as pathResolve } from 'node:path';

function stripTrailingSlash(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p;
}

export function isInsideWriteRoots(absPath: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return false;

  // Normalise `..` escapes; do NOT realpath (D8).
  const normalized = pathResolve(absPath);

  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0) continue;

    // Compare against both the bare and slash-suffixed forms so an
    // exact match (with or without trailing slash on either side)
    // counts as inside.
    const bare = stripTrailingSlash(root);
    if (normalized === bare) return true;

    const withSlash = bare + '/';
    if (normalized.startsWith(withSlash)) return true;
  }

  return false;
}
