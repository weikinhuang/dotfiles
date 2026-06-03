/**
 * Per-call git worktree lifecycle for the subagent extension's
 * `isolation: "worktree"` mode: create a throwaway checkout for a child
 * run, tear it down afterwards, and sweep any that a prior (crashed)
 * parent leaked under `.git/worktrees/`.
 *
 * Companion to {@link ./session-paths.ts}, which owns the pure
 * `listStaleWorktrees` discovery half (fs injected); this module owns
 * the mutating half (shells out to `git`). It is deliberately separate
 * from {@link ../git-worktree.ts}, which only *reads* worktree metadata
 * from disk for the statusline and never spawns a subprocess.
 *
 * Impure by necessity: `createWorktree`/`removeWorktree`/
 * `sweepStaleWorktrees` invoke `git`. They follow the repo convention
 * (see `lib/node/pi/sandbox/git-tracked.ts`) of folding every failure
 * mode - non-repo cwd, missing `git`, spawn error - into a benign
 * fallback rather than throwing, so a sweep never blocks session
 * start/shutdown. The non-deterministic bits (temp dir, id) are
 * injected so vitest can drive the happy path against a real repo.
 *
 * Imports only `node:*` + the peer `session-paths.ts`, so it stays
 * unit-testable under vitest with no pi runtime.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listStaleWorktrees, type SweepFs } from './session-paths.ts';

/**
 * Shell out to `git` safely. Uses `execFileSync` so arguments are
 * passed argv-style (no shell word splitting); path and branch names
 * never reach `/bin/sh`. Returns true on exit 0, false otherwise.
 */
export function runGit(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

export interface CreatedWorktree {
  /** Absolute path of the checkout inside the temp dir. */
  path: string;
  /** Outer temp dir - must be `rm -rf`d after `git worktree remove`. */
  tmpDir: string;
  /** Branch name created by `git worktree add -b`. */
  branch: string;
}

/**
 * Default unique id for a throwaway worktree branch + temp dir. Split
 * out so tests can inject a deterministic generator.
 */
export function defaultWorktreeId(): string {
  return `pi-subagent-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Create a fresh linked worktree on a new branch off `cwd`'s HEAD,
 * checked out inside a `mkdtempSync` parent so cleanup can wipe the
 * whole shell. Returns `{ error }` (and cleans up the temp dir) when
 * `git worktree add` fails.
 */
export function createWorktree(
  cwd: string,
  genId: () => string = defaultWorktreeId,
): CreatedWorktree | { error: string } {
  const branch = genId();
  const tmp = mkdtempSync(join(tmpdir(), 'pi-subagent-wt-'));
  const path = join(tmp, 'checkout');
  if (runGit(cwd, ['worktree', 'add', '-b', branch, path])) {
    return { path, tmpDir: tmp, branch };
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // tmp may not have been fully created - benign.
  }
  return { error: `git worktree add failed for ${path}` };
}

export function removeWorktree(parentCwd: string, wt: Pick<CreatedWorktree, 'path' | 'tmpDir' | 'branch'>): void {
  // `git worktree remove --force` tears down the checkout AND removes the
  // .git/worktrees/<branch>/ bookkeeping. If that fails (repo renamed,
  // moved, or corrupted), fall back to wiping the outer tmp dir so we
  // at least don't leak disk - the bookkeeping pointer can be cleaned up
  // by the next `git worktree prune` sweep.
  const removedViaGit = runGit(parentCwd, ['worktree', 'remove', '--force', wt.path]);
  if (!removedViaGit) {
    try {
      rmSync(wt.tmpDir, { recursive: true, force: true });
    } catch {
      // manual cleanup is the user's problem at this point
    }
  } else {
    // `git worktree remove` drops the `checkout` subdir but leaves our
    // `mkdtempSync` parent dir in place; clean it up so /tmp doesn't
    // accumulate empty pi-subagent-wt-* shells.
    try {
      rmSync(wt.tmpDir, { recursive: true, force: true });
    } catch {
      // benign - empty dir only
    }
  }
  // Branch deletion is best-effort; if the branch was checked out
  // elsewhere the -D still works because the worktree is gone.
  runGit(parentCwd, ['branch', '-D', wt.branch]);
}

export interface WorktreeSweepResult {
  /** Number of stale worktrees found and attempted-to-remove. */
  swept: number;
}

/**
 * Remove worktrees a prior parent leaked under `.git/worktrees/`.
 * Discovery is delegated to {@link listStaleWorktrees} with the
 * injected `fs`; removal shells out to `git`. Returns the count found
 * so the caller can surface it (matching `sweepStaleSessions`, which
 * returns a result rather than taking a notify callback).
 */
export function sweepStaleWorktrees(cwd: string, fs: Pick<SweepFs, 'readdir' | 'stat'>): WorktreeSweepResult {
  const stale = listStaleWorktrees(cwd, fs);
  if (stale.length === 0) return { swept: 0 };
  // Prune first so .git/worktrees/ bookkeeping matches disk; otherwise
  // `worktree remove` on a dir git doesn't know about is a no-op.
  runGit(cwd, ['worktree', 'prune']);
  for (const path of stale) {
    if (!runGit(cwd, ['worktree', 'remove', '--force', path])) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // manual cleanup required
      }
    }
  }
  return { swept: stale.length };
}
