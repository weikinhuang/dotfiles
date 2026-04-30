/**
 * Pure helpers for config/pi/extensions/statusline.ts.
 *
 * Derives the current git worktree name (for linked worktrees created via
 * `git worktree add`) entirely from on-disk metadata — no subprocess
 * required. Mirrors pi's own `findGitPaths` logic in
 * `@mariozechner/pi-coding-agent/dist/core/footer-data-provider.js` and
 * surfaces what Claude Code hands to `config/claude/statusline-command.sh`
 * via the pre-computed `workspace.git_worktree` field.
 *
 * Scheme:
 *   - `<repo>/.git` is a **directory** ⇒ main worktree. No worktree name.
 *   - `<repo>/.git` is a **file** whose content is `gitdir: <abs-path>`
 *     with the target laid out as `<commonGitDir>/worktrees/<name>/` ⇒
 *     linked worktree. `<name>` equals what was passed to
 *     `git worktree add`.
 *   - `<repo>/.git` is a file pointing anywhere else (submodules use
 *     `<super>/.git/modules/<name>/`, `--separate-git-dir` uses an
 *     arbitrary path) ⇒ treat as a plain repo, no worktree name. This
 *     matters because otherwise `cd`ing into a submodule would render
 *     the submodule's name as if it were a worktree.
 *
 * This module imports only from `node:*` so it stays unit-testable under
 * `vitest` with no pi runtime.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface WorktreeInfo {
  /** Absolute path to the worktree's gitdir (== `commonGitDir` for the main worktree). */
  gitDir: string;
  /** Absolute path to the main repo's gitdir. */
  commonGitDir: string;
  /**
   * Directory where `.git` was found (i.e. the worktree root). Useful for
   * callers that want to display a path relative to the worktree.
   */
  repoDir: string;
  /**
   * Worktree name for linked worktrees — `basename(gitDir)`, which git
   * guarantees equals the name passed to `git worktree add`. `null` for
   * the main worktree (where `gitDir === commonGitDir`).
   */
  worktreeName: string | null;
}

/**
 * Walk upward from `cwd` to locate the enclosing git worktree.
 *
 * Returns `null` when we never hit a `.git` entry before running out of
 * parents, when `.git` exists but the `gitdir: …` target is missing, or
 * when fs reads fail (permissions, etc.). Callers treat a `null` result
 * as "no worktree info available" and render nothing.
 */
export function resolveWorktreeInfo(cwd: string, maxDepth = 64): WorktreeInfo | null {
  if (!cwd) return null;

  let dir = cwd;
  for (let i = 0; i < maxDepth; i++) {
    const gitPath = join(dir, '.git');
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);

        if (stat.isFile()) {
          // `.git` is a pointer file. This covers linked worktrees, git
          // submodules (`.git/modules/<name>/`), and `--separate-git-dir`
          // setups. Only linked worktrees should surface a name to the UI.
          const content = readFileSync(gitPath, 'utf8').trim();
          if (!content.startsWith('gitdir: ')) return null;
          const gitDir = resolve(dir, content.slice('gitdir: '.length).trim());
          if (!existsSync(join(gitDir, 'HEAD'))) return null;

          // `commondir` is written by `git worktree add` (git ≥ 2.5) and
          // points back to the main repo's `.git`. Submodules do NOT write
          // this file, so its presence is the first signal we're looking
          // at a linked worktree rather than a submodule or separate-git-dir.
          const commonDirFile = join(gitDir, 'commondir');
          const hasCommondir = existsSync(commonDirFile);
          const commonGitDir = hasCommondir ? resolve(gitDir, readFileSync(commonDirFile, 'utf8').trim()) : gitDir;

          // Second signal: linked worktrees always live at
          // `<commonGitDir>/worktrees/<name>/`. Submodules live at
          // `<super>/.git/modules/<name>/` and will fail this check.
          // `--separate-git-dir` targets live anywhere and also fail.
          const isLinkedWorktree = hasCommondir && dirname(gitDir) === join(commonGitDir, 'worktrees');
          const worktreeName = isLinkedWorktree ? basename(gitDir) : null;

          return { repoDir: dir, gitDir, commonGitDir, worktreeName };
        }

        if (stat.isDirectory()) {
          // Main worktree: `.git` is the gitdir itself.
          return { repoDir: dir, gitDir: gitPath, commonGitDir: gitPath, worktreeName: null };
        }
      } catch {
        return null;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }

  return null;
}
