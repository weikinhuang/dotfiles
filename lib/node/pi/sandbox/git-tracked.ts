/**
 * Tiny synchronous probe: which of the supplied absolute paths are
 * tracked in the git index of `cwd`?
 *
 * Used by the sandbox extension to decide whether a 0-byte file (or
 * empty directory) at one of ASRT's dangerous-file basenames is a
 * leaked stub from a prior pi session (safe to adopt + clean up) or
 * a file the user actually committed at zero bytes (must be left
 * alone). The lib-level `dangerous-file-stubs.ts` already filters by
 * size + emptiness; this helper layers the git-tracked guard on top
 * via the `isProtected` hook those functions accept.
 *
 * Intentionally synchronous: it only runs once per cwd per session
 * (we cache the resulting Set on the runtime state) and `git
 * ls-files` against ~30 explicit paths returns in single-digit
 * milliseconds. Going async would force every call site through
 * promise plumbing it does not otherwise need.
 *
 * Failure modes folded into "tracked = ∅":
 *
 *   - `cwd` is not a git repo (`fatal: not a git repository`)
 *   - `git` is not installed / not on PATH (ENOENT)
 *   - the spawn errors or hits the 2-second hard timeout
 *
 * Folding all of these into "nothing tracked, adopt freely" is the
 * conservative-for-the-bug, permissive-for-the-user behavior: in a
 * non-git scratch dir the orphan stubs still get cleaned up, and the
 * size + emptiness guards in `dangerous-file-stubs.ts` keep us from
 * deleting any populated user file.
 *
 * Pure module - imports only `node:*` - so it stays unit-testable
 * with vitest.
 */

import { execFileSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Return the subset of `candidates` (absolute paths under `cwd`) that
 * are listed in `cwd`'s git index. Paths outside `cwd` are silently
 * dropped so a malformed input never escapes the sandbox boundary.
 */
export function gitTrackedSubset(cwd: string, candidates: readonly string[]): Set<string> {
  const tracked = new Set<string>();
  if (candidates.length === 0) return tracked;

  // Filter to candidates strictly under cwd, and convert to cwd-relative
  // POSIX-ish paths for the git invocation.
  const rels: string[] = [];
  const absByRel = new Map<string, string>();
  for (const abs of candidates) {
    const norm = resolve(abs);
    if (norm !== cwd && !norm.startsWith(cwd + sep)) continue;
    const rel = relative(cwd, norm);
    if (rel.length === 0) continue;
    if (rel.startsWith('..')) continue;
    rels.push(rel);
    absByRel.set(rel, norm);
  }
  if (rels.length === 0) return tracked;

  let stdout: string;
  try {
    stdout = execFileSync('git', ['-C', cwd, 'ls-files', '-z', '--', ...rels], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      encoding: 'utf8',
    });
  } catch {
    return tracked;
  }

  for (const rel of stdout.split('\0')) {
    if (rel.length === 0) continue;
    const abs = absByRel.get(rel);
    if (abs !== undefined) {
      tracked.add(abs);
    } else {
      // git emitted a different separator form (e.g. forward slashes
      // when our input used backslashes on Windows). Fall back to a
      // resolve(cwd, rel) join so the caller still gets a hit.
      tracked.add(resolve(cwd, rel));
    }
  }
  return tracked;
}

/**
 * Resolve the absolute path of the git exclude file for `cwd`
 * (`<git-common-dir>/info/exclude`), or `undefined` when `cwd` is not
 * inside a git work tree (bare repo, non-repo, git missing, or the
 * spawn errors / times out).
 *
 * Uses `git rev-parse --git-common-dir` rather than assuming
 * `<cwd>/.git/info/exclude`: in a linked worktree `.git` is a file and
 * the real `info/exclude` lives under the shared common dir. The
 * common-dir output can be relative (typically `.git`) - it is
 * resolved against `cwd`.
 *
 * Synchronous with a 2s hard timeout, mirroring {@link gitTrackedSubset}.
 */
export function resolveGitExcludeFile(cwd: string): string | undefined {
  let commonDir: string;
  try {
    commonDir = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
  if (commonDir.length === 0) return undefined;
  const abs = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  return join(abs, 'info', 'exclude');
}
