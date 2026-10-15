/** Real-repository regression tests for conservative worktree cleanup. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { atomicWriteFile } from '../../../../../lib/node/pi/atomic-write.ts';
import {
  createWorktree,
  formatWorktreeRecovery,
  listStaleWorktrees,
  removeWorktree,
  sweepStaleWorktrees,
  type CreatedWorktree,
} from '../../../../../lib/node/pi/subagent/worktree.ts';

let repo: string;
let tempDirs: string[];

test('worktree recovery explains preserved checkouts and committed branches', () => {
  expect(
    formatWorktreeRecovery({
      path: '/wt',
      branch: 'pi-subagent-x',
      removed: false,
      branchPreserved: true,
      reason: 'dirty',
    }),
  ).toBe('Child workspace preserved at /wt (dirty). Recovery branch: pi-subagent-x.');
  expect(formatWorktreeRecovery({ path: '/wt', branch: 'pi-subagent-x', removed: true, branchPreserved: true })).toBe(
    'Child work preserved on branch pi-subagent-x.',
  );
  expect(formatWorktreeRecovery({ path: '/wt', removed: true, branchPreserved: false })).toBeUndefined();
});

function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'tests',
      GIT_AUTHOR_EMAIL: 'tests@example.com',
      GIT_COMMITTER_NAME: 'tests',
      GIT_COMMITTER_EMAIL: 'tests@example.com',
    },
  });
}

function create(id = 'test'): CreatedWorktree {
  const wt = createWorktree(repo, () => `pi-subagent-${id}`);
  if ('error' in wt) throw new Error(wt.error);
  tempDirs.push(wt.tmpDir);
  return wt;
}

function ownerPath(wt: CreatedWorktree): string {
  return join(wt.tmpDir, 'pi-subagent-owner.json');
}

function updateOwner(wt: CreatedWorktree, patch: Record<string, unknown>): void {
  const owner = JSON.parse(readFileSync(ownerPath(wt), 'utf8')) as Record<string, unknown>;
  atomicWriteFile(ownerPath(wt), JSON.stringify({ ...owner, ...patch }));
}

/** The synchronous child is reaped before we test its PID, so ESRCH is real. */
function deadOwner(wt: CreatedWorktree): void {
  const pid = Number(
    execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    }),
  );
  expect(() => process.kill(pid, 0)).toThrow('ESRCH');
  updateOwner(wt, { pid });
}

function branchExists(wt: CreatedWorktree): boolean {
  return gitAt(repo, 'branch', '--list', wt.branch).trim().length > 0;
}

beforeEach(() => {
  tempDirs = [];
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'subagent-worktree-')));
  gitAt(repo, 'init', '-q');
  writeFileSync(join(repo, 'README'), 'seed\n', 'utf8');
  gitAt(repo, 'add', 'README');
  gitAt(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('createWorktree', () => {
  test('creates a real checkout with ownership metadata outside the worktree', () => {
    const wt = create('fixed');
    expect(wt.branch).toBe('pi-subagent-fixed');
    expect(existsSync(join(wt.path, 'README'))).toBe(true);
    const owner = JSON.parse(readFileSync(ownerPath(wt), 'utf8')) as Record<string, unknown>;
    expect(owner).toMatchObject({ version: 1, pid: process.pid, path: wt.path, branch: wt.branch });
    expect(gitAt(wt.path, 'status', '--porcelain')).toBe('');
    expect(branchExists(wt)).toBe(true);
  });

  test('returns an error for a non-repo and removes only the empty shell', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'subagent-not-repo-'));
    tempDirs.push(notRepo);
    const wt = createWorktree(notRepo, () => 'pi-subagent-x');
    expect('error' in wt).toBe(true);
    if (!('error' in wt)) throw new Error('unexpected successful creation');
    if (!wt.tmpDir) throw new Error('missing failed-creation path');
    expect(existsSync(wt.tmpDir)).toBe(false);
  });
});

describe('removeWorktree', () => {
  test('removes its own clean checkout, empty shell, and unchanged branch', () => {
    const wt = create('rm');
    expect(removeWorktree(repo, wt)).toEqual({
      path: wt.path,
      branch: wt.branch,
      removed: true,
      branchPreserved: false,
    });
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(wt.tmpDir)).toBe(false);
    expect(branchExists(wt)).toBe(false);
  });

  test.each(['tracked', 'staged', 'untracked', 'ignored'])('preserves %s changes and branch', (kind) => {
    const wt = create();
    if (kind === 'tracked' || kind === 'staged') {
      writeFileSync(join(wt.path, 'README'), 'valuable edits\n');
      if (kind === 'staged') gitAt(wt.path, 'add', 'README');
    } else {
      if (kind === 'ignored') gitAt(wt.path, 'config', 'core.excludesFile', join(repo, 'ignore'));
      if (kind === 'ignored') writeFileSync(join(repo, 'ignore'), 'valuable\n');
      writeFileSync(join(wt.path, 'valuable'), 'valuable untracked data\n');
    }
    expect(removeWorktree(repo, wt)).toMatchObject({ removed: false, branchPreserved: true, reason: 'dirty' });
    expect(existsSync(wt.path)).toBe(true);
    expect(branchExists(wt)).toBe(true);
  });

  test('removes a clean checkout but retains the branch with child commits', () => {
    const wt = create();
    writeFileSync(join(wt.path, 'README'), 'committed work\n');
    gitAt(wt.path, 'commit', '-am', 'child work');
    const head = gitAt(wt.path, 'rev-parse', 'HEAD');
    expect(removeWorktree(repo, wt)).toMatchObject({ removed: true, branchPreserved: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(gitAt(repo, 'rev-parse', wt.branch)).toBe(head);
  });

  test('preserves checkout and branch on git removal failure, without an rm fallback', () => {
    const wt = create();
    gitAt(repo, 'worktree', 'lock', wt.path);
    expect(removeWorktree(repo, wt)).toMatchObject({ removed: false, reason: 'git-failed' });
    expect(readFileSync(join(wt.path, 'README'), 'utf8')).toBe('seed\n');
    expect(branchExists(wt)).toBe(true);
    expect(existsSync(ownerPath(wt))).toBe(true);
  });

  test('does not remove other files in the outer shell after successful git removal', () => {
    const wt = create();
    writeFileSync(join(wt.tmpDir, 'recovery'), 'keep');
    expect(removeWorktree(repo, wt).removed).toBe(true);
    expect(readFileSync(join(wt.tmpDir, 'recovery'), 'utf8')).toBe('keep');
  });

  test.each(['missing', 'malformed', 'foreign-lease', 'wrong-branch'])('preserves %s ownership', (kind) => {
    const wt = create();
    if (kind === 'missing') unlinkSync(ownerPath(wt));
    if (kind === 'malformed') writeFileSync(ownerPath(wt), '{');
    if (kind === 'foreign-lease') updateOwner(wt, { lease: 'different-process-instance' });
    const candidate = kind === 'wrong-branch' ? { ...wt, branch: 'pi-subagent-other' } : wt;
    expect(removeWorktree(repo, candidate)).toMatchObject({ removed: false, reason: 'unknown-owner' });
    expect(existsSync(wt.path)).toBe(true);
    expect(branchExists(wt)).toBe(true);
  });

  test('preserves a checkout whose branch changed after creation', () => {
    const wt = create();
    gitAt(wt.path, 'checkout', '-b', 'other-branch');
    expect(removeWorktree(repo, wt)).toMatchObject({ removed: false, reason: 'git-failed' });
    expect(existsSync(wt.path)).toBe(true);
    expect(branchExists(wt)).toBe(true);
  });

  test('preserves a checkout when the parent repo cannot be queried', () => {
    const wt = create();
    expect(removeWorktree('/does-not-exist', wt)).toMatchObject({ removed: false, reason: 'unknown-owner' });
    expect(existsSync(wt.path)).toBe(true);
    expect(branchExists(wt)).toBe(true);
  });
});

describe('listStaleWorktrees', () => {
  test('lists prefix candidates without assuming they are stale', () => {
    const porcelain = [
      `worktree ${repo}`,
      'branch refs/heads/main',
      '',
      'worktree /tmp/pi-subagent-wt-x/checkout',
      'branch refs/heads/pi-subagent-x',
      '',
    ].join('\n');
    expect(listStaleWorktrees(repo, () => porcelain)).toEqual(['/tmp/pi-subagent-wt-x/checkout']);
    expect(listStaleWorktrees(repo, () => null)).toEqual([]);
  });
});

describe('sweepStaleWorktrees', () => {
  test('no candidates or failed discovery is a no-op', () => {
    expect(sweepStaleWorktrees(repo, () => '')).toEqual({ swept: 0, results: [] });
    expect(sweepStaleWorktrees(repo, () => null)).toEqual({ swept: 0, results: [] });
  });

  test('preserves live clean worktrees, including another session in the same process', () => {
    const own = create('own');
    const other = create('other-session');
    updateOwner(other, { lease: 'other-session' });
    const res = sweepStaleWorktrees(repo);
    expect(res.swept).toBe(0);
    expect(res.results).toHaveLength(2);
    expect(res.results.every((result) => result.reason === 'live-owner')).toBe(true);
    expect(existsSync(own.path)).toBe(true);
    expect(existsSync(other.path)).toBe(true);
  });

  test('removes only dead-owner clean worktrees, not live, dirty or unknown candidates', () => {
    const clean = create('dead-clean');
    const dirty = create('dead-dirty');
    const live = create('live');
    const unknown = create('unknown');
    deadOwner(clean);
    deadOwner(dirty);
    writeFileSync(join(dirty.path, 'README'), 'recover me\n');
    unlinkSync(ownerPath(unknown));
    const res = sweepStaleWorktrees(repo);
    expect(res.swept).toBe(1);
    expect(res.results).toContainEqual({
      path: clean.path,
      branch: clean.branch,
      removed: true,
      branchPreserved: false,
    });
    expect(existsSync(clean.path)).toBe(false);
    expect(existsSync(clean.tmpDir)).toBe(false);
    for (const wt of [dirty, live, unknown]) {
      expect(existsSync(wt.path)).toBe(true);
      expect(branchExists(wt)).toBe(true);
    }
    expect(readFileSync(join(dirty.path, 'README'), 'utf8')).toBe('recover me\n');
  });

  test('retains dead-owner committed branches for recovery', () => {
    const wt = create();
    writeFileSync(join(wt.path, 'README'), 'child commit\n');
    gitAt(wt.path, 'commit', '-am', 'child work');
    deadOwner(wt);
    const res = sweepStaleWorktrees(repo);
    expect(res.swept).toBe(1);
    expect(res.results[0]).toMatchObject({ removed: true, branchPreserved: true });
    expect(branchExists(wt)).toBe(true);
  });

  test.each(['foreign-host', 'malformed', 'invalid-pid', 'wrong-path', 'wrong-repo'])(
    'preserves %s metadata rather than inferring ownership from a branch prefix',
    (kind) => {
      const wt = create();
      deadOwner(wt);
      if (kind === 'foreign-host') updateOwner(wt, { host: 'not-this-host' });
      if (kind === 'malformed') writeFileSync(ownerPath(wt), 'null');
      if (kind === 'invalid-pid') updateOwner(wt, { pid: -1 });
      if (kind === 'wrong-path') updateOwner(wt, { path: '/somewhere-else' });
      if (kind === 'wrong-repo') updateOwner(wt, { commonDir: '/another/.git' });
      const res = sweepStaleWorktrees(repo);
      expect(res.swept).toBe(0);
      expect(res.results[0]).toMatchObject({ reason: 'unknown-owner' });
      expect(existsSync(wt.path)).toBe(true);
    },
  );

  test('treats permission-denied process probes as live/uncertain, not dead', () => {
    const wt = create();
    const error = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });
    const res = sweepStaleWorktrees(repo);
    expect(res.swept).toBe(0);
    expect(res.results[0]).toMatchObject({ reason: 'live-owner' });
    expect(existsSync(wt.path)).toBe(true);
  });

  test('does not fall back to filesystem deletion when git refuses a dead-owner checkout', () => {
    const wt = create();
    deadOwner(wt);
    gitAt(repo, 'worktree', 'lock', wt.path);
    const res = sweepStaleWorktrees(repo);
    expect(res.swept).toBe(0);
    expect(res.results[0]).toMatchObject({ removed: false, reason: 'git-failed' });
    expect(existsSync(wt.path)).toBe(true);
    expect(branchExists(wt)).toBe(true);
  });

  test('never deletes an unknown directory from an injected listing', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'pi-subagent-wt-orphan-'));
    tempDirs.push(orphan);
    writeFileSync(join(orphan, 'valuable'), 'keep');
    const porcelain = [`worktree ${orphan}`, 'branch refs/heads/pi-subagent-orphan', ''].join('\n');
    expect(sweepStaleWorktrees(repo, () => porcelain).swept).toBe(0);
    expect(readFileSync(join(orphan, 'valuable'), 'utf8')).toBe('keep');
  });
});
