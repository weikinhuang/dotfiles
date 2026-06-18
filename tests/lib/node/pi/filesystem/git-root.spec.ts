/**
 * Tests for `lib/node/pi/filesystem/git-root.ts` - the inject-`exists`
 * walk-up that locates the git root for the approval dialog.
 */

import { describe, expect, test } from 'vitest';

import { findGitRoot } from '../../../../../lib/node/pi/filesystem/git-root.ts';

describe('findGitRoot', () => {
  test('returns the directory that contains .git', () => {
    const repo = '/home/u/proj';
    const exists = (p: string): boolean => p === `${repo}/.git`;
    expect(findGitRoot(`${repo}/src/app`, exists)).toBe(repo);
  });

  test('matches at the start directory itself', () => {
    const repo = '/home/u/proj';
    const exists = (p: string): boolean => p === `${repo}/.git`;
    expect(findGitRoot(repo, exists)).toBe(repo);
  });

  test('treats a .git file (worktree / submodule) as a root', () => {
    const wt = '/home/u/worktree';
    const exists = (p: string): boolean => p === `${wt}/.git`;
    expect(findGitRoot(`${wt}/deep/nested`, exists)).toBe(wt);
  });

  test('returns undefined when no .git is found up to the root', () => {
    expect(findGitRoot('/home/u/proj/src', () => false)).toBeUndefined();
  });

  test('returns the nearest (innermost) root when nested repos exist', () => {
    const exists = (p: string): boolean => p === '/a/.git' || p === '/a/b/.git';
    expect(findGitRoot('/a/b/c', exists)).toBe('/a/b');
  });

  test('terminates at the filesystem root', () => {
    const exists = (p: string): boolean => p === '/.git';
    expect(findGitRoot('/x/y', exists)).toBe('/');
  });
});
