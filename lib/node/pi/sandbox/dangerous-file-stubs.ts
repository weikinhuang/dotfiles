/**
 * Pre-create empty stubs for ASRT's `DANGEROUS_FILES` (`.gitconfig`,
 * `.bashrc`, `.gitmodules`, ...) in the current working directory, so
 * concurrent bwrap invocations don't race on the mount-point creation.
 *
 * Background: when ASRT wraps a bash command on Linux, it appends
 * `--ro-bind /dev/null <cwd>/.bashrc` (and similar) for every
 * non-existent dangerous file. Bwrap then has to create the host-side
 * mount-point file with `O_CREAT|O_WRONLY` mode `0444` before binding
 * `/dev/null` over it.
 *
 * If a second bwrap starts before the first one releases its mount,
 * the second call sees the stub already on disk with mode `0444` and
 * its own `O_CREAT|O_WRONLY` returns `EACCES` ("Can't create file at
 * <path>: Permission denied"). The whole wrapped command then exits
 * non-zero with that bwrap setup error - even on trivial reads like
 * `rg -l ... config/pi/extensions/`.
 *
 * Mitigation: before each `wrapWithSandbox`, we touch the stub at
 * `<cwd>/<name>` with `O_CREAT|O_EXCL` mode `0644`. Real user files
 * stay untouched (EEXIST is a no-op for us). Bwrap then takes the
 * "file exists + within allowed write path" branch
 * (`linux-sandbox-utils.js:651`) which emits `--ro-bind <path> <path>`
 * - no `O_CREAT|O_WRONLY` on a 0444 file, no race.
 *
 * Pure module - no pi imports - so it's unit-testable under vitest.
 * The list of dangerous files is kept in sync with ASRT's
 * `DANGEROUS_FILES` in
 * `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js`;
 * see `dangerous-file-stubs.spec.ts` for the drift guard.
 */

import { closeSync, constants, openSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

/** The list of basenames ASRT treats as "dangerous" and adds to its
 *  Linux mandatory deny list at `<cwd>/<name>` per
 *  `linuxGetMandatoryDenyPaths`. Must match ASRT's `DANGEROUS_FILES`
 *  constant in `sandbox-utils.js`; the spec asserts the set is a
 *  subset of ASRT's array. */
export const DANGEROUS_FILE_STUBS: readonly string[] = Object.freeze([
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
]);

/**
 * Best-effort touch each dangerous-file basename at `cwd` with
 * `O_CREAT|O_EXCL` mode `0644`. Returns the absolute paths we
 * actually created (callers track these for cleanup). Files that
 * already exist (EEXIST) are skipped and NOT returned, so we never
 * delete a real user file.
 *
 * Errors other than EEXIST are also swallowed: a permission error on
 * the cwd would have made the original bwrap-side create fail
 * regardless, so we'd just degrade to the same state we were in
 * before this mitigation existed.
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
  return created;
}

/**
 * Unlink each path in `created`, but only if it is still a zero-byte
 * regular file - guards against removing a real file the user (or
 * another tool) wrote to during the session. Returns the paths that
 * were actually removed.
 *
 * Best-effort: missing files or unexpected stat shapes are silently
 * skipped so a partial cleanup never crashes the extension shutdown
 * path.
 */
export function cleanupDangerousFileStubs(created: Iterable<string>): string[] {
  const removed: string[] = [];
  for (const abs of created) {
    try {
      const st = statSync(abs);
      if (st.isFile() && st.size === 0) {
        unlinkSync(abs);
        removed.push(abs);
      }
    } catch {
      // Stub may already be gone, or stat failed; ignore.
    }
  }
  return removed;
}
