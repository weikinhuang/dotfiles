import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { resolveWorktreeInfo } from '../../../../lib/node/pi/git-worktree.ts';

let sandbox = '';

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-git-worktree-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Stand up a fake main worktree (`<sandbox>/repo/.git/` as a directory).
 * Returns the repo path.
 */
function setupMainRepo(): string {
  const repo = join(sandbox, 'repo');
  mkdirSync(join(repo, '.git/worktrees'), { recursive: true });
  writeFileSync(join(repo, '.git/HEAD'), 'ref: refs/heads/main\n');
  return repo;
}

/**
 * Stand up a linked worktree rooted at `<sandbox>/<name>` whose `.git` file
 * points at `<main-repo>/.git/worktrees/<name>`. Returns the linked
 * worktree root path.
 */
function setupLinkedWorktree(mainRepo: string, name: string, opts: { withCommondir?: boolean } = {}): string {
  const { withCommondir = true } = opts;
  const linkedGitDir = join(mainRepo, '.git/worktrees', name);
  mkdirSync(linkedGitDir, { recursive: true });
  writeFileSync(join(linkedGitDir, 'HEAD'), 'ref: refs/heads/feature\n');
  if (withCommondir) {
    // Matches what `git worktree add` writes: a relative path back to the
    // main `.git` directory.
    writeFileSync(join(linkedGitDir, 'commondir'), '../..\n');
  }

  const worktreeRoot = join(sandbox, name);
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(join(worktreeRoot, '.git'), `gitdir: ${linkedGitDir}\n`);
  return worktreeRoot;
}

// ──────────────────────────────────────────────────────────────────────
// Main / linked worktree detection
// ──────────────────────────────────────────────────────────────────────

test('resolveWorktreeInfo: main worktree returns null worktreeName', () => {
  const repo = setupMainRepo();
  const info = resolveWorktreeInfo(repo);

  expect(info).toBeTruthy();
  expect(info!.worktreeName).toBe(null);
  expect(info!.repoDir).toBe(repo);
  expect(info!.gitDir).toBe(join(repo, '.git'));
  expect(info!.commonGitDir).toBe(info!.gitDir);
});

test('resolveWorktreeInfo: linked worktree exposes its name from .git/worktrees/<name>', () => {
  const repo = setupMainRepo();
  const linked = setupLinkedWorktree(repo, 'feature-x');

  const info = resolveWorktreeInfo(linked);

  expect(info).toBeTruthy();
  expect(info!.worktreeName).toBe('feature-x');
  expect(info!.repoDir).toBe(linked);
  expect(info!.gitDir).toBe(join(repo, '.git/worktrees/feature-x'));
  // commondir (`../..`) resolves relative to gitDir → main `.git`.
  expect(info!.commonGitDir).toBe(join(repo, '.git'));
});

test('resolveWorktreeInfo: linked worktree without a commondir file is treated conservatively as no worktree', () => {
  // `commondir` is the signal that distinguishes linked worktrees from
  // submodules (which use the same `.git`-as-pointer-file scheme). Without
  // it we refuse to guess — returning null avoids mislabelling a submodule
  // or `--separate-git-dir` repo. Modern git (≥ 2.5) always writes this file
  // for `git worktree add`, so this only affects hand-crafted layouts.
  const repo = setupMainRepo();
  const linked = setupLinkedWorktree(repo, 'legacy', { withCommondir: false });

  const info = resolveWorktreeInfo(linked);

  expect(info).toBeTruthy();
  expect(info!.worktreeName).toBe(null);
  expect(info!.commonGitDir).toBe(info!.gitDir);
});

test('resolveWorktreeInfo: submodule cwd does NOT masquerade as a worktree', () => {
  // Submodules use the same `.git`-as-pointer-file scheme as linked
  // worktrees, but the target lives under `<super>/.git/modules/<name>/`
  // rather than `<super>/.git/worktrees/<name>/`, and git doesn't write a
  // `commondir` helper for submodules. Either check is enough to avoid
  // labelling a submodule's name as a worktree.
  const superRepo = join(sandbox, 'super');
  mkdirSync(join(superRepo, '.git/modules/payments'), { recursive: true });
  writeFileSync(join(superRepo, '.git/HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(superRepo, '.git/modules/payments/HEAD'), 'ref: refs/heads/main\n');

  const submoduleRoot = join(superRepo, 'services/payments');
  mkdirSync(submoduleRoot, { recursive: true });
  writeFileSync(join(submoduleRoot, '.git'), `gitdir: ${join(superRepo, '.git/modules/payments')}\n`);

  const info = resolveWorktreeInfo(submoduleRoot);

  expect(info).toBeTruthy();
  expect(info!.worktreeName).toBe(null);
});

test('resolveWorktreeInfo: --separate-git-dir pointers are not treated as worktrees', () => {
  // `git init --separate-git-dir` produces a `.git` file with an arbitrary
  // gitdir target that does not live under a `worktrees/` directory and
  // lacks a `commondir` helper.
  const separateGitDir = join(sandbox, 'elsewhere', 'project.git');
  mkdirSync(separateGitDir, { recursive: true });
  writeFileSync(join(separateGitDir, 'HEAD'), 'ref: refs/heads/main\n');

  const repoRoot = join(sandbox, 'project');
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, '.git'), `gitdir: ${separateGitDir}\n`);

  const info = resolveWorktreeInfo(repoRoot);

  expect(info).toBeTruthy();
  expect(info!.worktreeName).toBe(null);
});

test('resolveWorktreeInfo: linked worktree whose gitdir pointer is stale returns null', () => {
  const worktreeRoot = join(sandbox, 'broken');
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(join(worktreeRoot, '.git'), `gitdir: ${join(sandbox, 'does/not/exist')}\n`);

  expect(resolveWorktreeInfo(worktreeRoot)).toBe(null);
});

// ──────────────────────────────────────────────────────────────────────
// Parent walk, cwd variants
// ──────────────────────────────────────────────────────────────────────

test('resolveWorktreeInfo: walks upward from a subdirectory to find .git', () => {
  const repo = setupMainRepo();
  const deep = join(repo, 'src/a/b/c');
  mkdirSync(deep, { recursive: true });

  const info = resolveWorktreeInfo(deep);

  expect(info).toBeTruthy();
  expect(info!.repoDir).toBe(repo);
  expect(info!.worktreeName).toBe(null);
});

test('resolveWorktreeInfo: walks upward from inside a linked worktree subdir', () => {
  const repo = setupMainRepo();
  const linked = setupLinkedWorktree(repo, 'topic');
  const deep = join(linked, 'packages/widget/src');
  mkdirSync(deep, { recursive: true });

  const info = resolveWorktreeInfo(deep);

  expect(info).toBeTruthy();
  expect(info!.worktreeName).toBe('topic');
  expect(info!.repoDir).toBe(linked);
});

test('resolveWorktreeInfo: returns null for paths with no enclosing repo', () => {
  const lonely = join(sandbox, 'not-a-repo/a/b/c');
  mkdirSync(lonely, { recursive: true });

  expect(resolveWorktreeInfo(lonely, 4)).toBe(null);
});

test('resolveWorktreeInfo: empty cwd is treated as no repo', () => {
  expect(resolveWorktreeInfo('')).toBe(null);
});

test('resolveWorktreeInfo: honors maxDepth', () => {
  const repo = setupMainRepo();
  const deep = join(repo, 'a/b/c/d/e/f/g/h/i/j');
  mkdirSync(deep, { recursive: true });

  // Too shallow to reach the repo's .git …
  expect(resolveWorktreeInfo(deep, 3)).toBe(null);

  // … but deep enough it succeeds.
  const info = resolveWorktreeInfo(deep, 32);

  expect(info).toBeTruthy();
  expect(info!.repoDir).toBe(repo);
});
