/**
 * Node `fs` adapter for the {@link SweepFs} shape consumed by the sweep
 * helpers in [`session-paths.ts`](./session-paths.ts) and
 * [`worktree.ts`](./worktree.ts).
 *
 * The sweep logic itself is pure and injected with this shape so tests can
 * drive it with in-memory data; this module is the one real-filesystem
 * binding. Every call is best-effort - a failed `readdir` / `stat` yields
 * `null` and a failed `remove` yields `false` - so a sweep never throws on a
 * racing unlink or a permission error.
 *
 * Pure module (node built-ins only) so it stays under the root `tsconfig`.
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';

import { type SweepFs } from './session-paths.ts';

/** Build a {@link SweepFs} backed by the real Node filesystem. */
export function makeSweepFs(): SweepFs {
  return {
    readdir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return null;
      }
    },
    stat: (path) => {
      try {
        const s = statSync(path);
        return { mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
      } catch {
        return null;
      }
    },
    remove: (path) => {
      try {
        unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
