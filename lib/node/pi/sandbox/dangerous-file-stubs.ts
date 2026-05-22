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
export function createDangerousFileStubs(cwd: string): string[] {
  const created: string[] = [];
  for (const name of DANGEROUS_FILE_STUBS) {
    const abs = resolve(cwd, name);
    try {
      const fd = openSync(abs, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
      closeSync(fd);
      created.push(abs);
    } catch {
      // EEXIST or other; do not track for cleanup.
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
        // EEXIST or other; continue walking the next component.
      }
    }
  }
  return created;
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
