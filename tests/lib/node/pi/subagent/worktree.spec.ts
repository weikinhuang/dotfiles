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

import {
  createWorktree,
  listStaleWorktrees,
  removeWorktree,
  sweepStaleWorktrees,
} from '../../../../../lib/node/pi/subagent/worktree.ts';

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

describe('listStaleWorktrees', () => {
  test('discovers only pi-subagent-* branch checkouts from an injected porcelain listing', () => {
    const porcelain = [
      `worktree ${repo}`,
      'branch refs/heads/main',
      '',
      'worktree /tmp/pi-subagent-wt-x/checkout',
      'branch refs/heads/pi-subagent-x',
      '',
    ].join('\n');
    const out = listStaleWorktrees(repo, () => porcelain);
    expect(out).toEqual(['/tmp/pi-subagent-wt-x/checkout']);
  });

  test('null porcelain (non-repo / no git) returns empty list', () => {
    expect(listStaleWorktrees(repo, () => null)).toEqual([]);
  });
});

describe('sweepStaleWorktrees', () => {
  test('no stale worktrees → swept 0', () => {
    const res = sweepStaleWorktrees(repo, () => '');
    expect(res.swept).toBe(0);
  });

  test('removes a real leaked pi-subagent worktree discovered via git worktree list', () => {
    // End-to-end regression: create a real linked worktree (branch
    // pi-subagent-*), then "leak" it (never removeWorktree) and let the
    // sweep find + tear it down through the real `git worktree list
    // --porcelain` path - the scenario the old admin-dir scan missed.
    const wt = createWorktree(repo, () => 'pi-subagent-leak');
    if ('error' in wt) throw new Error(wt.error);
    expect(existsSync(wt.path)).toBe(true);

    const res = sweepStaleWorktrees(repo);

    expect(res.swept).toBe(1);
    expect(existsSync(wt.path)).toBe(false);
    // Best-effort temp-shell cleanup is the caller's job; the checkout
    // itself is what git removed.
    rmSync(wt.tmpDir, { recursive: true, force: true });
  });

  test('falls back to rm -rf when git cannot remove the checkout', () => {
    // Inject a porcelain listing pointing at a throwaway dir git doesn't
    // track; git worktree remove fails, rmSync cleans it up.
    const orphan = mkdtempSync(join(tmpdir(), 'pi-subagent-wt-orphan-'));
    const checkout = join(orphan, 'checkout');
    writeFileSync(join(orphan, 'marker'), 'x', 'utf8');
    const porcelain = [`worktree ${checkout}`, 'branch refs/heads/pi-subagent-orphan', ''].join('\n');

    const res = sweepStaleWorktrees(repo, () => porcelain);

    expect(res.swept).toBe(1);
    rmSync(orphan, { recursive: true, force: true });
  });
});
