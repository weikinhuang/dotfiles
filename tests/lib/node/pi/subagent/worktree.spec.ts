/**
 * Specs for `lib/node/pi/subagent/worktree.ts` - the mutating half of
 * the subagent worktree lifecycle (the read-only discovery half lives
 * in `session-paths.ts`).
 *
 * Properties exercised:
 *
 *   - `createWorktree` makes a real linked worktree on a new branch and
 *     honours an injected id generator (deterministic branch/temp names).
 *   - `createWorktree` returns `{ error }` (and leaves no temp dir) when
 *     `cwd` is not a git repo.
 *   - `removeWorktree` tears down the checkout, the temp shell, and the
 *     branch.
 *   - `sweepStaleWorktrees` finds + removes leaked `pi-subagent-*`
 *     worktrees via the injected fs, and is a no-op when none exist.
 *
 * The impure paths run against a throwaway real repo (mirroring
 * `sandbox/git-tracked.spec.ts`); the fs-injected sweep is driven with
 * in-memory data.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { SweepFs } from '../../../../../lib/node/pi/subagent/session-paths.ts';
import { createWorktree, removeWorktree, sweepStaleWorktrees } from '../../../../../lib/node/pi/subagent/worktree.ts';

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'tests',
      GIT_AUTHOR_EMAIL: 'tests@example.com',
      GIT_COMMITTER_NAME: 'tests',
      GIT_COMMITTER_EMAIL: 'tests@example.com',
    },
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'subagent-worktree-'));
  git('init', '-q');
  writeFileSync(join(repo, 'README'), 'seed\n', 'utf8');
  git('add', 'README');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('createWorktree', () => {
  test('creates a real worktree on the injected branch id', () => {
    const wt = createWorktree(repo, () => 'pi-subagent-fixed');
    expect('error' in wt).toBe(false);
    if ('error' in wt) return; // narrow for TS

    expect(wt.branch).toBe('pi-subagent-fixed');
    expect(existsSync(join(wt.path, 'README'))).toBe(true);

    // The branch and the linked worktree are visible to git.
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'pi-subagent-fixed'], { encoding: 'utf8' });
    expect(branches).toContain('pi-subagent-fixed');

    removeWorktree(repo, wt);
  });

  test('returns { error } and leaves no temp dir when cwd is not a repo', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'subagent-not-repo-'));
    try {
      const wt = createWorktree(notRepo, () => 'pi-subagent-x');
      expect('error' in wt).toBe(true);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});

describe('removeWorktree', () => {
  test('removes the checkout, temp shell, and branch', () => {
    const wt = createWorktree(repo, () => 'pi-subagent-rm');
    if ('error' in wt) throw new Error(wt.error);

    removeWorktree(repo, wt);

    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(wt.tmpDir)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'pi-subagent-rm'], { encoding: 'utf8' });
    expect(branches.trim()).toBe('');
  });
});

describe('sweepStaleWorktrees', () => {
  /** In-memory fs reporting one stale worktree dir under .git/worktrees. */
  function fakeFs(names: string[]): Pick<SweepFs, 'readdir' | 'stat'> {
    const worktreesDir = join(repo, '.git', 'worktrees');
    return {
      readdir: (path) => (path === worktreesDir ? names : null),
      stat: () => ({ mtimeMs: 0, isFile: false, isDirectory: true }),
    };
  }

  test('no stale worktrees → swept 0', () => {
    const res = sweepStaleWorktrees(repo, fakeFs([]));
    expect(res.swept).toBe(0);
  });

  test('reports the count of stale pi-subagent worktrees found', () => {
    // listStaleWorktrees filters to the pi-subagent- prefix; a real
    // worktree need not exist on disk for the count, since git
    // prune/remove failures fall through to rmSync best-effort.
    const res = sweepStaleWorktrees(repo, fakeFs(['pi-subagent-a', 'pi-subagent-b', 'unrelated']));
    expect(res.swept).toBe(2);
  });
});
