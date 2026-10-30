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
 * The mandatory file / directory lists are VENDORED from ASRT below
 * rather than imported, so this stays a pure module (no third-party
 * runtime import outside `ext/`, per lib/node/pi/AGENTS.md). Drift is
 * guarded by `dangerous-file-stubs.spec.ts`, which imports
 * ASRT directly (tests may import anything) and fails if the runtime's
 * lists diverge from the vendored copies here.
 *
 * The additional "best-effort" file list mirrors the broader stub set
 * Claude Code creates in its `assertScrubSandboxAvailable` path - it
 * covers files that aren't in ASRT's mandatory deny today but are
 * commonly added by user policy (`.npmrc`, `package.json`, lockfiles).
 *
 * Pure module - no pi imports - so it's unit-testable under vitest.
 */

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, rmdirSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import { createGlobalSlot } from '../global-slot.ts';

/**
 * Vendored copy of ASRT's `DANGEROUS_FILES`
 * (`@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js`). Kept
 * in sync by `dangerous-file-stubs.spec.ts`. */
export const ASRT_DANGEROUS_FILES: readonly string[] = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
];

/**
 * Vendored copy of ASRT's `getDangerousDirectories()` return value
 * (`.git` is intentionally excluded by ASRT - it stays writable and
 * specific paths inside it are denied instead). Kept in sync by
 * `dangerous-file-stubs.spec.ts`. */
export const ASRT_DANGEROUS_DIRECTORIES: readonly string[] = ['.vscode', '.idea', '.claude/commands', '.claude/agents'];

/** Additional per-call protection filter. Return `true` to skip a path.
 *  Ownership is always required independently of this hook: an empty
 *  file or directory is never evidence that this process created it. */
export interface DangerousStubOptions {
  isProtected?: (abs: string) => boolean;
}

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
export const DANGEROUS_DIR_STUBS: readonly string[] = Object.freeze([...ASRT_DANGEROUS_DIRECTORIES]);

interface OwnedStub {
  dev: number;
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  directory: boolean;
}

// Shared across extension module copies. Refcounts remain the caller's
// responsibility; this registry records provenance, not active users.
const getOwnership = createGlobalSlot<{ paths: Map<string, OwnedStub> }>(
  '@dotfiles/pi/sandbox/dangerous-file-stubs',
  () => ({ paths: new Map() }),
);

/** Refuse symlinks in every ancestor, including cwd itself. */
function hasSafeAncestors(abs: string): boolean {
  try {
    let parent = dirname(abs);
    for (;;) {
      const st = lstatSync(parent);
      if (!st.isDirectory() || st.isSymbolicLink()) return false;
      const next = dirname(parent);
      if (next === parent) return true;
      parent = next;
    }
  } catch {
    return false;
  }
}

function rememberStub(abs: string, st: Stats): void {
  getOwnership().paths.set(abs, {
    dev: st.dev,
    ino: st.ino,
    birthtimeMs: st.birthtimeMs,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    directory: st.isDirectory(),
  });
}

/** lstat identity, not a basename / size heuristic, establishes ownership. */
function ownedStub(abs: string): OwnedStub | undefined {
  const paths = getOwnership().paths;
  const owned = paths.get(abs);
  if (!owned) return undefined;
  try {
    if (hasSafeAncestors(abs)) {
      const st = lstatSync(abs);
      const sameIdentity = st.dev === owned.dev && st.ino === owned.ino && st.birthtimeMs === owned.birthtimeMs;
      // Directory mtimes change as we create/remove nested stubs. File
      // timestamps also catch user edits that truncate back to zero.
      const sameShape = owned.directory
        ? st.isDirectory()
        : st.isFile() && st.size === 0 && st.mtimeMs === owned.mtimeMs && st.ctimeMs === owned.ctimeMs;
      if (!st.isSymbolicLink() && sameIdentity && sameShape) return owned;
    }
  } catch {
    // Missing, replaced, or inaccessible: relinquish ownership.
  }
  paths.delete(abs);
  return undefined;
}

/**
 * Enumerate every candidate mount point under cwd. A candidate name is
 * never evidence that this process owns an existing file or directory.
 */
export function listDangerousStubPaths(cwd: string): string[] {
  cwd = resolve(cwd);
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
 * Best-effort create missing mount points, returning newly created and
 * already-owned paths. Unknown EEXIST entries are never adopted, even
 * when empty. Reused owned directories may contain our nested stubs;
 * callers must retain all returned paths in their parallel-wrap ledger.
 * Symlink leaves and ancestors are never traversed intentionally.
 */
export function createDangerousFileStubs(cwd: string, opts: DangerousStubOptions = {}): string[] {
  const isProtected = opts.isProtected ?? (() => false);
  const created = new Set<string>();
  for (const abs of new Set(listDangerousStubPaths(cwd))) {
    if (isProtected(abs) || !hasSafeAncestors(abs)) continue;
    const directory = !DANGEROUS_FILE_STUBS.some((name) => resolve(cwd, name) === abs);
    try {
      if (directory) {
        mkdirSync(abs, { mode: 0o755 });
        rememberStub(abs, lstatSync(abs));
      } else {
        const fd = openSync(
          abs,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o644,
        );
        try {
          rememberStub(abs, fstatSync(fd));
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      // EEXIST is reusable only with matching process-local ownership.
      // Other errors are best-effort failures; unknown paths stay unknown.
    }
    if (ownedStub(abs)) created.add(abs);
  }
  return [...created];
}

/**
 * Remove only process-owned stubs with unchanged lstat identities and
 * no symlink ancestors. Files must also remain unmodified and zero-byte;
 * directories must still be empty. Unknown paths are ignored even if
 * explicitly passed by the caller. Cleanup walks deepest-first (longest path wins)
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
    const owned = ownedStub(abs);
    if (!owned) continue;
    try {
      if (owned.directory) {
        // Non-recursive rmdir refuses a directory that gained entries.
        rmdirSync(abs);
      } else {
        unlinkSync(abs);
      }
      getOwnership().paths.delete(abs);
      removed.push(abs);
    } catch {
      // Stub may have gained content or become inaccessible; leave it.
    }
  }
  return removed;
}

/**
 * Sweep only stubs whose ownership is known to this process, subject
 * to the additional `isProtected` filter. Name, emptiness, and git
 * tracking cannot prove ownership. Crash leftovers from prior processes
 * are deliberately left alone; no ownership metadata is persisted.
 * Callers must exclude paths still held by their parallel-wrap ledger.
 * Returns the absolute paths actually unlinked / rmdir'd.
 */
export function sweepOrphanDangerousStubs(cwd: string, opts: DangerousStubOptions = {}): string[] {
  const isProtected = opts.isProtected ?? (() => false);
  const candidates = listDangerousStubPaths(cwd).filter((abs) => !isProtected(abs));
  return cleanupDangerousFileStubs(candidates);
}
