/**
 * Pure git-argv builders + output parsers for `full` mode's side git-dir
 * snapshot. The shell runs these argv arrays with `execFile('git', argv)`;
 * keeping them pure makes the command shapes unit-testable and keeps the
 * dangerous bits (which flags we pass to `clean`) reviewable in one place.
 *
 * The snapshot repo lives in a side git-dir OUTSIDE the user's `.git`
 * (`<storeDir>/git`), with `--work-tree` pointed at the project cwd. We
 * never touch the user's refs / index / stash / history, and it works in a
 * non-git cwd. `git add -A` honors the work-tree's `.gitignore`, so ignored
 * paths (`node_modules/`, `.env`, secrets, large binaries) are never
 * snapshotted - the untracked-files contract documented in the `.md`.
 *
 * Safety invariant: the clean builders emit `-fd` and NEVER `-x` (which
 * would nuke ignored files), and always scope with `-- <paths>`.
 *
 * No pi imports.
 */

import { join } from 'node:path';

/** Absolute path to the side git-dir for a project's store dir. */
export function sideGitDir(storeDir: string): string {
  return join(storeDir, 'git');
}

/** The leading `--git-dir … --work-tree …` flags shared by every command. */
function base(gitDir: string, workTree: string): string[] {
  return ['--git-dir', gitDir, '--work-tree', workTree];
}

/** `git --git-dir=DIR init` - create the side repo (idempotent). */
export function initArgs(gitDir: string): string[] {
  return ['--git-dir', gitDir, 'init', '--quiet'];
}

/** Stage the whole work-tree (honors `.gitignore`). */
export function addAllArgs(gitDir: string, workTree: string): string[] {
  return [...base(gitDir, workTree), 'add', '-A'];
}

/** Paths currently staged (names only) - parsed by {@link parseNameOnly} for the caps check. */
export function stagedNameOnlyArgs(gitDir: string, workTree: string): string[] {
  return [...base(gitDir, workTree), 'diff', '--cached', '--name-only', '-z'];
}

/**
 * Commit the staged snapshot. `--allow-empty` so a no-change message still
 * produces a ref (the `agent_end` reaper drops refs whose tree is
 * unchanged); `--no-verify` so a user's hooks never run against our side
 * repo; identity is pinned via args so it works with no git `user.*` config.
 */
export function commitArgs(gitDir: string, workTree: string, message: string): string[] {
  return [
    ...base(gitDir, workTree),
    '-c',
    'user.name=pi-checkpoint',
    '-c',
    'user.email=pi-checkpoint@localhost',
    'commit',
    '--no-verify',
    '--allow-empty',
    '--quiet',
    '-m',
    message,
  ];
}

/** Resolve the current snapshot commit sha (stored as the manifest `treeRef`). */
export function revParseHeadArgs(gitDir: string, workTree: string): string[] {
  return [...base(gitDir, workTree), 'rev-parse', 'HEAD'];
}

/** Tree sha of a commit - used by the reaper to detect an unchanged snapshot. */
export function treeOfArgs(gitDir: string, workTree: string, ref: string): string[] {
  return [...base(gitDir, workTree), 'rev-parse', `${ref}^{tree}`];
}

/** Restore `paths` from `treeRef` into the work-tree (`checkout -f … -- paths`). */
export function checkoutArgs(gitDir: string, workTree: string, treeRef: string, paths: readonly string[]): string[] {
  return [...base(gitDir, workTree), 'checkout', '-f', treeRef, '--', ...paths];
}

/**
 * Preview what `clean` would remove, scoped to `paths`. `-fdn` = force, dirs,
 * dry-run. NEVER `-x` (that would delete ignored files). The shell shows this
 * preview before the real clean when `full.confirmClean` is set.
 */
export function cleanDryRunArgs(gitDir: string, workTree: string, paths: readonly string[]): string[] {
  return [...base(gitDir, workTree), 'clean', '-fdn', '--', ...paths];
}

/** Remove files created since the snapshot, scoped to `paths`. `-fd`, never `-x`. */
export function cleanArgs(gitDir: string, workTree: string, paths: readonly string[]): string[] {
  return [...base(gitDir, workTree), 'clean', '-fd', '--', ...paths];
}

/** Parse `-z`-delimited `--name-only` output into a path list. */
export function parseNameOnly(stdout: string): string[] {
  return stdout.split('\0').filter((s) => s.length > 0);
}

/**
 * `git diff --name-status -z <ref>` - compare the snapshot `ref`'s tree to
 * the current work-tree, listing each changed path with its status letter.
 * Used to build the full-mode review rows (disk vs the target snapshot).
 */
export function diffNameStatusArgs(gitDir: string, workTree: string, ref: string): string[] {
  return [...base(gitDir, workTree), 'diff', '--name-status', '-z', ref];
}

/** Read one path's bytes as recorded in a snapshot tree (`git show <ref>:<path>`). */
export function showFileArgs(gitDir: string, workTree: string, ref: string, path: string): string[] {
  return [...base(gitDir, workTree), 'show', `${ref}:${path}`];
}

export interface NameStatusEntry {
  /** Single letter: A (added on disk), D (deleted on disk), M (modified), … */
  status: string;
  path: string;
}

/**
 * Parse `git diff --name-status -z` output. The `-z` format is
 * `STATUS\0path\0` per entry (rename/copy emit an extra path which we
 * fold onto the same status by consuming both tokens). Status is read
 * relative to `<ref> → work-tree`, so `A` means "present on disk, absent in
 * the snapshot", `D` means "in the snapshot, gone from disk".
 */
export function parseNameStatusZ(stdout: string): NameStatusEntry[] {
  const tokens = stdout.split('\0').filter((s) => s.length > 0);
  const out: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (i >= tokens.length) break;
    const letter = status[0];
    // Rename/copy (R100 / C75) carry two paths: old then new. Use the new path.
    if (letter === 'R' || letter === 'C') {
      i++; // skip old path
      const newPath = tokens[i++];
      if (newPath !== undefined) out.push({ status: letter, path: newPath });
    } else {
      const path = tokens[i++];
      if (path !== undefined) out.push({ status: letter, path });
    }
  }
  return out;
}

/** Parse `git clean -fdn` preview lines (`Would remove <path>`) into paths. */
export function parseCleanDryRun(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^Would remove (.+)$/.exec(line.trim());
    if (m) out.push(m[1]);
  }
  return out;
}

export interface CapDecision {
  /** True when the staged set is within both caps and may be committed. */
  ok: boolean;
  /** Human-readable reason when `ok` is false (for the notify). */
  reason?: string;
}

/**
 * Decide whether a staged snapshot is within the configured caps. `files`
 * is the staged path list; `totalBytes` is their summed size (the shell
 * stats them). Over either cap → skip the tree snapshot (the cap is the
 * backstop behind the `.gitignore` exclusion).
 */
export function withinCaps(
  files: readonly string[],
  totalBytes: number,
  maxStagedFiles: number,
  maxStagedBytes: number,
): CapDecision {
  if (files.length > maxStagedFiles) {
    return { ok: false, reason: `${files.length} staged files exceeds cap ${maxStagedFiles}` };
  }
  if (totalBytes > maxStagedBytes) {
    return { ok: false, reason: `${totalBytes} staged bytes exceeds cap ${maxStagedBytes}` };
  }
  return { ok: true };
}
