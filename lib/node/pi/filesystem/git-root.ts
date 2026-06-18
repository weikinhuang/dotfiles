/**
 * Find the git root containing a path by walking up the directory tree
 * looking for a `.git` entry (a directory in a normal checkout, or a
 * file in a worktree / submodule). Pure: filesystem access is injected
 * via the `exists` predicate so the walk is unit-testable without
 * touching disk.
 *
 * Used by the `filesystem` extension's approval dialog to offer
 * "allow the git root for this session" as a broader session-allow
 * scope than the single file or its parent directory.
 */

import { dirname, join } from 'node:path';

/** Predicate: does `path` exist on disk (file OR directory)? */
export type ExistsFn = (path: string) => boolean;

/**
 * Walk up from `startDir` (inclusive) to the filesystem root, returning
 * the first directory that contains a `.git` entry, or `undefined` when
 * none is found. `startDir` should already be an absolute, resolved
 * directory path.
 */
export function findGitRoot(startDir: string, exists: ExistsFn): string | undefined {
  let dir = startDir;
  // `dirname('/') === '/'` and `dirname('C:\\') === 'C:\\'`, so the
  // loop terminates when `dirname` stops changing the path.
  for (;;) {
    if (exists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
