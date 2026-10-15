/** Conservative lifecycle management for subagent-owned git worktrees. */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { atomicWriteFile } from '../atomic-write.ts';
import { parseStaleWorktreePaths } from './session-paths.ts';

/** False on any git/spawn failure. Arguments never pass through a shell. */
export function runGit(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/** Capture stdout, or null on any git/spawn failure. */
export function runGitCapture(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Prefix matches are only candidates, not evidence of stale ownership. */
export function listStaleWorktrees(
  cwd: string,
  listPorcelain: (cwd: string) => string | null = (c) => runGitCapture(c, ['worktree', 'list', '--porcelain']),
): string[] {
  const porcelain = listPorcelain(cwd);
  return porcelain === null ? [] : parseStaleWorktreePaths(porcelain);
}

export interface CreatedWorktree {
  path: string;
  tmpDir: string;
  branch: string;
}

interface WorktreeOwner extends CreatedWorktree {
  version: 1;
  pid: number;
  host: string;
  /** Distinguishes this process instance from another instance reusing its PID. */
  lease: string;
  initialHead: string;
  commonDir: string;
}

const processLease = randomUUID();
const ownerFile = 'pi-subagent-owner.json';

function commonDir(cwd: string): string | null {
  return runGitCapture(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim() ?? null;
}

function readOwner(path: string, cwd: string): WorktreeOwner | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dirname(path), ownerFile), 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const owner = value as Partial<WorktreeOwner>;
    if (
      owner.version !== 1 ||
      !Number.isSafeInteger(owner.pid) ||
      typeof owner.pid !== 'number' ||
      owner.pid <= 0 ||
      owner.host !== hostname() ||
      typeof owner.lease !== 'string' ||
      owner.lease.length === 0 ||
      typeof owner.branch !== 'string' ||
      !owner.branch.startsWith('pi-subagent-') ||
      typeof owner.initialHead !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(owner.initialHead) ||
      owner.path !== path ||
      owner.tmpDir !== dirname(path) ||
      join(owner.tmpDir, 'checkout') !== path ||
      typeof owner.commonDir !== 'string' ||
      owner.commonDir !== commonDir(cwd)
    )
      return null;
    return owner as WorktreeOwner;
  } catch {
    return null;
  }
}

/** Only ESRCH proves death. EPERM and all other uncertainty mean "keep". */
function ownerIsDead(owner: WorktreeOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
}

/** Never recursively remove a shell: it may contain unrelated/recoverable files. */
function removeEmptyShell(tmpDir: string, removeOwner = false): void {
  try {
    if (removeOwner) unlinkSync(join(tmpDir, ownerFile));
    rmdirSync(tmpDir);
  } catch {
    // Unknown files or filesystem errors leave the shell intact.
  }
}

export function defaultWorktreeId(): string {
  return `pi-subagent-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Failed creation never recursively wipes a potentially partial checkout. */
export function createWorktree(
  cwd: string,
  genId: () => string = defaultWorktreeId,
): CreatedWorktree | { error: string; path?: string; tmpDir?: string; branch?: string } {
  const branch = genId();
  let tmp: string;
  try {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pi-subagent-wt-')));
  } catch {
    return { error: 'Could not create worktree temp directory' };
  }
  const path = join(tmp, 'checkout');
  const wt = { path, tmpDir: tmp, branch };
  if (!runGit(cwd, ['worktree', 'add', '-b', branch, path])) {
    removeEmptyShell(tmp);
    return { error: `git worktree add failed for ${path}; any partial checkout was preserved`, ...wt };
  }
  const initialHead = runGitCapture(path, ['rev-parse', 'HEAD'])?.trim();
  const repoDir = commonDir(cwd);
  if (initialHead && repoDir) {
    const owner: WorktreeOwner = {
      ...wt,
      version: 1,
      pid: process.pid,
      host: hostname(),
      lease: processLease,
      initialHead,
      commonDir: repoDir,
    };
    try {
      atomicWriteFile(join(tmp, ownerFile), JSON.stringify(owner));
      return wt;
    } catch {
      // Leave checkout and branch recoverable if recording ownership fails.
    }
  }
  return { error: `Could not record worktree ownership; preserved ${path}`, ...wt };
}

export interface WorktreeRemovalResult {
  path: string;
  /** Present when ownership metadata identified the recovery branch. */
  branch?: string;
  removed: boolean;
  /** True unless deletion of the original, unchanged branch was confirmed. */
  branchPreserved: boolean;
  reason?: 'unknown-owner' | 'live-owner' | 'dirty' | 'git-failed';
}

/** Recovery information must reach the parent instead of silently leaking a checkout. */
export function formatWorktreeRecovery(result: WorktreeRemovalResult): string | undefined {
  if (!result.removed) {
    return (
      `Child workspace preserved at ${result.path} (${result.reason ?? 'cleanup incomplete'}).` +
      (result.branch ? ` Recovery branch: ${result.branch}.` : '')
    );
  }
  if (result.branchPreserved && result.branch) return `Child work preserved on branch ${result.branch}.`;
  return undefined;
}

function removeOwnedWorktree(cwd: string, owner: WorktreeOwner): WorktreeRemovalResult {
  const result: WorktreeRemovalResult = {
    path: owner.path,
    branch: owner.branch,
    removed: false,
    branchPreserved: true,
  };
  // Prove this is still the recorded checkout and branch before trusting status.
  const top = runGitCapture(owner.path, ['rev-parse', '--show-toplevel'])?.trim();
  const branch = runGitCapture(owner.path, ['symbolic-ref', '--quiet', 'HEAD'])?.trim();
  if (top !== owner.path || branch !== `refs/heads/${owner.branch}`) {
    return { ...result, reason: 'git-failed' };
  }
  // Include ignored files and submodules: they can hold valuable uncommitted work too.
  const status = runGitCapture(owner.path, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignored',
    '--ignore-submodules=none',
  ]);
  if (status === null) return { ...result, reason: 'git-failed' };
  if (status.length > 0) return { ...result, reason: 'dirty' };
  if (!runGit(cwd, ['worktree', 'remove', owner.path])) return { ...result, reason: 'git-failed' };
  result.removed = true;
  removeEmptyShell(owner.tmpDir, true);
  // Never force-delete a branch. Commits made by the child remain recoverable,
  // even when they happen to be merged into the parent's current HEAD.
  const tip = runGitCapture(cwd, ['rev-parse', `refs/heads/${owner.branch}`])?.trim();
  if (tip === owner.initialHead) {
    result.branchPreserved = !runGit(cwd, ['branch', '-d', owner.branch]);
  }
  return result;
}

/** Remove only this process's clean checkout. Failures preserve checkout and branch. */
export function removeWorktree(
  parentCwd: string,
  wt: Pick<CreatedWorktree, 'path' | 'tmpDir' | 'branch'>,
): WorktreeRemovalResult {
  const owner = readOwner(wt.path, parentCwd);
  if (
    !owner ||
    owner.pid !== process.pid ||
    owner.lease !== processLease ||
    owner.tmpDir !== wt.tmpDir ||
    owner.branch !== wt.branch
  )
    return { path: wt.path, removed: false, branchPreserved: true, reason: 'unknown-owner' };
  return removeOwnedWorktree(parentCwd, owner);
}

export interface WorktreeSweepResult {
  /** Successfully removed clean checkouts, not merely prefix matches. */
  swept: number;
  /** Preserved candidates and branch recovery information for caller notifications. */
  results: WorktreeRemovalResult[];
}

/** Sweep only locally owned, demonstrably dead-process, clean checkouts. */
export function sweepStaleWorktrees(
  cwd: string,
  listPorcelain: (cwd: string) => string | null = (c) => runGitCapture(c, ['worktree', 'list', '--porcelain']),
): WorktreeSweepResult {
  const results = listStaleWorktrees(cwd, listPorcelain).map((path): WorktreeRemovalResult => {
    const owner = readOwner(path, cwd);
    if (!owner) return { path, removed: false, branchPreserved: true, reason: 'unknown-owner' };
    if (!ownerIsDead(owner))
      return { path, branch: owner.branch, removed: false, branchPreserved: true, reason: 'live-owner' };
    return removeOwnedWorktree(cwd, owner);
  });
  return { swept: results.filter((result) => result.removed).length, results };
}
