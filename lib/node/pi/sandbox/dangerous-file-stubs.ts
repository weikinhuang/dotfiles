/**
 * Pre-create empty stubs for the files AND directories ASRT marks as
 * mandatory write-denies, so concurrent bwrap invocations don't race
 * on the mount-point creation.
 *
 * Background: when ASRT wraps a bash command on Linux, it appends
 * `--ro-bind /dev/null <cwd>/.bashrc` (and similar) for every
 * non-existent dangerous file, and `--ro-bind <emptyDir>
 * <cwd>/.claude/commands` for every non-existent dangerous directory.
 * Bwrap then has to create the host-side mount-point with
 * `O_CREAT|O_WRONLY` mode `0444` (file) or `mkdir` mode `0700` (dir)
 * before binding.
 *
 * If a second bwrap starts before the first one releases its mount,
 * the second call sees the stub already on disk and its own `O_CREAT|
 * O_WRONLY` returns `EACCES` ("Can't create file at <path>: Permission
 * denied") - or in the directory case, `mkdir` returns `EEXIST` but
 * `mkdir(parent)` returns `EACCES` against a 0700 stub. The whole
 * wrapped command then exits non-zero with that bwrap setup error -
 * even on trivial reads like `rg -l ... config/pi/extensions/`.
 *
 * Mitigation: before each `wrapWithSandbox`, we touch the stub at
 * `<cwd>/<name>` with `O_CREAT|O_EXCL` mode `0644` for files, and
 * `mkdir` mode `0755` for directories (walking each intermediate
 * component). Real user files / dirs stay untouched (EEXIST is a no-op
 * for us). Bwrap then takes the "exists + within allowed write path"
 * branch (`linux-sandbox-utils.js:651`) which emits `--ro-bind <path>
 * <path>` - no `O_CREAT|O_WRONLY` on a 0444 file, no race.
 *
 * The mandatory file / directory lists are imported directly from
 * ASRT so this stays in sync with the runtime we're actually wrapping.
 * The additional "best-effort" file list mirrors the broader stub set
 * Claude Code creates in its `assertScrubSandboxAvailable` path - it
 * covers files that aren't in ASRT's mandatory deny today but are
 * commonly added by user policy (`.npmrc`, `package.json`, lockfiles).
 *
 * Pure module - no pi imports - so it's unit-testable under vitest.
 */

import { closeSync, constants, mkdirSync, openSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** Per-call hook used to protect user-authored files / directories
 *  from adoption + cleanup. Return `true` to skip a path. The default
 *  (`undefined`) protects nothing - safe at the lib level because the
 *  size + DANGEROUS_*_STUBS membership filter already excludes any
 *  populated file or non-empty directory. The sandbox extension layers
 *  a git-tracked check on top via this hook. */
export interface DangerousStubOptions {
  isProtected?: (abs: string) => boolean;
}

import {
  DANGEROUS_FILES as ASRT_DANGEROUS_FILES,
  getDangerousDirectories as asrtGetDangerousDirectories,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';

/** Basenames ASRT always adds to its Linux mandatory write-deny list at
 *  `<cwd>/<name>`, plus the defensive extras from Claude Code's
 *  `assertScrubSandboxAvailable` workspace pre-touch list. The ASRT
 *  half is mandatory (race fix). The extras (lockfiles, `.npmrc`,
 *  etc.) cover the case where a user policy adds those to denyWrite. */
export const DANGEROUS_FILE_STUBS: readonly string[] = Object.freeze([
  ...ASRT_DANGEROUS_FILES,
  // Claude Code workspace pre-touch additions (not in ASRT's mandatory
  // list, but Claude Code creates them as bind-mount targets when
  // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1). Touching them here is a
  // defensive measure for users who add these to write.deny.
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'bunfig.toml',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

/** Relative paths (one or more components) that ASRT always adds as
 *  recursive write-denies. Sourced from ASRT directly so a runtime
 *  bump that extends the list (e.g. a new editor config dir) auto-
 *  applies without a code change here. */
export const DANGEROUS_DIR_STUBS: readonly string[] = Object.freeze(asrtGetDangerousDirectories());

/**
 * Best-effort touch each dangerous-file basename at `cwd` with
 * `O_CREAT|O_EXCL` mode `0644`, and `mkdir` each dangerous-directory
 * component under `cwd` with mode `0755`. Returns the absolute paths
 * we actually created (callers track these for cleanup). Items that
 * already exist (EEXIST) are skipped and NOT returned, so we never
 * delete a real user file or directory.
 *
 * For nested directory stubs (`.claude/commands`), each missing
 * intermediate component is created and tracked separately so cleanup
 * can rmdir them deepest-first.
 *
 * Errors other than EEXIST are swallowed: a permission error on the
 * cwd would have made the original bwrap-side create fail regardless,
 * so we'd just degrade to the same state we were in before this
 * mitigation existed.
 */
export function createDangerousFileStubs(cwd: string, opts: DangerousStubOptions = {}): string[] {
  const isProtected = opts.isProtected ?? (() => false);
  const created: string[] = [];
  for (const name of DANGEROUS_FILE_STUBS) {
    const abs = resolve(cwd, name);
    try {
      const fd = openSync(abs, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
      closeSync(fd);
      created.push(abs);
    } catch {
      // EEXIST: this stub may be a leftover from a previous session
      // that exited via SIGKILL / OOM / WSL VM kill before the
      // shutdown handler could fire. Adopt it for cleanup iff it is
      // still a 0-byte regular file AND the caller's `isProtected`
      // hook (typically a git-tracked check) does not flag it as
      // user-authored. Real, populated user files are filtered by
      // the size guard; freshly-cloned 0-byte files are guarded by
      // the git-tracked hook on top.
      if (isProtected(abs)) continue;
      try {
        const st = statSync(abs);
        if (st.isFile() && st.size === 0) created.push(abs);
      } catch {
        // stat failed (race / permissions); leave it alone.
      }
    }
  }
  for (const name of DANGEROUS_DIR_STUBS) {
    const abs = resolve(cwd, name);
    // Defensive: refuse to walk a name that escapes cwd.
    if (abs !== cwd && !abs.startsWith(cwd + sep)) continue;
    const rel = abs.slice(cwd.length + 1);
    const parts = rel.split(sep).filter((p) => p.length > 0);
    let cur = cwd;
    for (const p of parts) {
      cur = cur + sep + p;
      try {
        mkdirSync(cur, { mode: 0o755 });
        created.push(cur);
      } catch {
        // EEXIST or other: adopt the directory for cleanup iff it is
        // an EMPTY directory AND the caller has not flagged it as
        // protected. Populated dirs are skipped by the readdir guard;
        // tracked-empty dirs (rare) are guarded by `isProtected`.
        if (isProtected(cur)) continue;
        try {
          const st = statSync(cur);
          if (st.isDirectory() && readdirSync(cur).length === 0) created.push(cur);
        } catch {
          // stat failed; bail this component but keep walking deeper
          // in case the leaf itself is reachable. (mkdirSync on the
          // next component will just throw and we'll handle it the
          // same way.)
        }
      }
    }
  }
  return created;
}

/**
 * Enumerate every absolute path that the create-side helper might
 * touch under `cwd`: every DANGEROUS_FILE_STUBS basename plus every
 * intermediate component of every DANGEROUS_DIR_STUBS entry. Used by
 * the orphan-sweep helper to drive `cleanupDangerousFileStubs` over
 * the leaked-stub set on session start.
 *
 * Path-escape guard mirrors `createDangerousFileStubs` - directory
 * names that would walk outside `cwd` are silently skipped.
 */
export function listDangerousStubPaths(cwd: string): string[] {
  const out: string[] = [];
  for (const name of DANGEROUS_FILE_STUBS) {
    out.push(resolve(cwd, name));
  }
  for (const name of DANGEROUS_DIR_STUBS) {
    const abs = resolve(cwd, name);
    if (abs !== cwd && !abs.startsWith(cwd + sep)) continue;
    const rel = abs.slice(cwd.length + 1);
    const parts = rel.split(sep).filter((p) => p.length > 0);
    let cur = cwd;
    for (const p of parts) {
      cur = cur + sep + p;
      out.push(cur);
    }
  }
  return out;
}

/**
 * Remove each stub in `created`. Files are unlinked only if they are
 * still zero-byte regular files; directories are rmdir'd only if they
 * are still empty. Cleanup walks deepest-first (longest path wins)
 * so nested dir stubs (`.claude/commands` before `.claude`) clear
 * correctly when we own all the levels. Returns the paths actually
 * removed.
 *
 * Best-effort: missing entries or unexpected stat shapes are silently
 * skipped so a partial cleanup never crashes the extension shutdown
 * path.
 */
export function cleanupDangerousFileStubs(created: Iterable<string>): string[] {
  const removed: string[] = [];
  const items = [...created].sort((a, b) => b.length - a.length);
  for (const abs of items) {
    try {
      const st = statSync(abs);
      if (st.isFile() && st.size === 0) {
        unlinkSync(abs);
        removed.push(abs);
      } else if (st.isDirectory()) {
        if (readdirSync(abs).length === 0) {
          rmdirSync(abs);
          removed.push(abs);
        }
      }
    } catch {
      // Stub may already be gone, or stat failed; ignore.
    }
  }
  return removed;
}

/**
 * Sweep `cwd` for leaked dangerous-file stubs from a prior pi session
 * that exited too hard for `process.on('exit' | SIGTERM | SIGINT)`
 * to fire (SIGKILL, OOM, WSL VM kill, parent shell crash). Adopts any
 * 0-byte stub file or empty stub directory not flagged by
 * `opts.isProtected` and removes it via `cleanupDangerousFileStubs`,
 * which already enforces the deepest-first + zero-byte + empty-dir
 * invariants. Returns the absolute paths actually unlinked / rmdir'd.
 *
 * Safe to run unconditionally on session start: in a clean cwd the
 * stat() calls all fail with ENOENT and the function is a no-op.
 */
export function sweepOrphanDangerousStubs(cwd: string, opts: DangerousStubOptions = {}): string[] {
  const isProtected = opts.isProtected ?? (() => false);
  const candidates = listDangerousStubPaths(cwd).filter((abs) => !isProtected(abs));
  return cleanupDangerousFileStubs(candidates);
}
