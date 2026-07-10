/**
 * Manage a marked block inside a repo's git exclude file
 * (`<git-common-dir>/info/exclude`) that hides the sandbox's transient
 * dangerous-file stubs from `git status`.
 *
 * Background: on Linux, ASRT's mandatory write-denies are implemented
 * as `--ro-bind /dev/null <cwd>/<file>` (or `--tmpfs` for dirs), and
 * bwrap materializes the host-side mount point in the real working
 * copy for the lifetime of each wrapped command. Running `git status`
 * *through* the sandbox therefore lists `.bashrc`, `.gitconfig`,
 * `.mcp.json`, lockfiles, etc. as untracked files - noise that
 * confuses weaker models (they try to `git add`/`rm` the stubs or
 * narrate them as unexpected changes). See
 * `plans/pi-sandbox-git-exclude-and-deny-topology.md`.
 *
 * This mirrors Claude Code's `# claude-code scrub-mode stubs` append
 * to `.git/info/exclude`, but done more carefully:
 *
 *   - a begin/end **marker pair** so the block is idempotent across
 *     `/reload` and re-writes (Claude Code's plain `appendFile`
 *     accumulates duplicate blocks);
 *   - a **safe-basename predicate** ({@link computeExcludableStubs})
 *     that only hides a name when it is NOT git-tracked AND is absent
 *     or an empty stub - so a real user file (e.g. an untracked
 *     18-byte `.mcp.json`) is never shadowed;
 *   - the block is **stripped on session end** so the exclude file is
 *     untouched whenever pi is not running.
 *
 * Pure module - imports only `node:*` + peer lib - so the splice /
 * strip / predicate logic is unit-testable without a real repo. The
 * fs probes in {@link computeExcludableStubs} are dependency-injected.
 */

import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { DANGEROUS_DIR_STUBS, DANGEROUS_FILE_STUBS } from './dangerous-file-stubs.ts';

/** Opening marker line of the managed block. */
export const PI_SANDBOX_EXCLUDE_BEGIN = '# >>> pi-sandbox stubs >>>';
/** Closing marker line of the managed block. */
export const PI_SANDBOX_EXCLUDE_END = '# <<< pi-sandbox stubs <<<';

const BLOCK_HEADER_COMMENT = [
  '# Managed by the pi sandbox extension. These entries hide transient bwrap',
  '# dangerous-file mount points from `git status`. Auto-removed on session end.',
];

/**
 * Remove every pi-sandbox managed block from `content`, idempotently.
 *
 * Line-based so it self-heals corrupt states: each begin marker is
 * paired with the next end marker (inclusive removal); a dangling
 * begin with no end removes to EOF (our block is always written last,
 * so a lone begin is our own truncated write, not user content).
 * Trailing blank lines left behind by the removal are collapsed so the
 * file does not accumulate whitespace across write/strip cycles.
 */
export function stripManagedBlock(content: string): string {
  if (!content.includes(PI_SANDBOX_EXCLUDE_BEGIN)) return content;
  const lines = content.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping) {
      if (line.trim() === PI_SANDBOX_EXCLUDE_END) skipping = false;
      continue;
    }
    if (line.trim() === PI_SANDBOX_EXCLUDE_BEGIN) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  // Collapse trailing blank lines the removal may have exposed, then
  // restore a single trailing newline if the input had one.
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  const rebuilt = out.join('\n');
  if (rebuilt.length === 0) return '';
  return content.endsWith('\n') ? rebuilt + '\n' : rebuilt;
}

/**
 * Render the managed block for `entries` (already gitignore-formatted,
 * e.g. `/.bashrc`, `/.claude/commands/`). Returns the empty string for
 * an empty entry list so callers can treat "nothing to hide" uniformly.
 */
export function buildManagedBlock(entries: readonly string[]): string {
  if (entries.length === 0) return '';
  return [PI_SANDBOX_EXCLUDE_BEGIN, ...BLOCK_HEADER_COMMENT, ...entries, PI_SANDBOX_EXCLUDE_END].join('\n');
}

/**
 * Return `content` with any existing managed block replaced by a fresh
 * block for `entries`. When `entries` is empty, this is a pure strip.
 * The block is separated from prior content by exactly one blank line,
 * and the result ends with a single trailing newline.
 */
export function spliceManagedBlock(content: string, entries: readonly string[]): string {
  const stripped = stripManagedBlock(content);
  const block = buildManagedBlock(entries);
  if (block.length === 0) return stripped;
  const base = stripped.replace(/\n+$/, '');
  const prefix = base.length > 0 ? base + '\n\n' : '';
  return prefix + block + '\n';
}

// ──────────────────────────────────────────────────────────────────────
// Safe-basename predicate
// ──────────────────────────────────────────────────────────────────────

/** On-disk shape of a candidate stub path, from the caller's or the
 *  default fs probe. */
export type StubProbe = 'absent' | 'empty-file' | 'nonempty-file' | 'empty-dir' | 'nonempty-dir' | 'other';

/** Default probe: classify an absolute path via the real filesystem.
 *  Any error (missing, permission, race) folds to `absent`, matching
 *  the create-side helper's "adopt/skip" behavior. */
export function defaultStubProbe(abs: string): StubProbe {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return 'absent';
  }
  if (st.isFile()) return st.size === 0 ? 'empty-file' : 'nonempty-file';
  if (st.isDirectory()) {
    try {
      return readdirSync(abs).length === 0 ? 'empty-dir' : 'nonempty-dir';
    } catch {
      return 'nonempty-dir';
    }
  }
  return 'other';
}

export interface ExcludableStubsOptions {
  /** True when the absolute path is tracked in the repo's git index.
   *  Tracked files are unaffected by gitignore anyway; skipping keeps
   *  the block honest and avoids listing a committed file. Default:
   *  nothing tracked. */
  isTracked?: (abs: string) => boolean;
  /** Classify an absolute path. Injected in tests; defaults to the
   *  real-fs {@link defaultStubProbe}. */
  probe?: (abs: string) => StubProbe;
  /** Override the file-stub basename set (defaults to
   *  {@link DANGEROUS_FILE_STUBS}). */
  fileStubs?: readonly string[];
  /** Override the directory-stub relative-path set (defaults to
   *  {@link DANGEROUS_DIR_STUBS}). */
  dirStubs?: readonly string[];
}

/**
 * Compute the gitignore entries that are SAFE to hide under `cwd`: the
 * subset of the dangerous-stub names that are not git-tracked and are
 * either absent or an empty stub (0-byte file / empty dir). A present
 * non-empty file (a real user file - e.g. an untracked `.mcp.json`
 * with content) is never emitted, so the exclude block can never
 * shadow real work.
 *
 * File entries are anchored root-relative (`/.bashrc`); directory
 * entries carry a trailing slash (`/.claude/commands/`) so only that
 * exact subtree is hidden, never a real parent like `.claude`.
 */
export function computeExcludableStubs(cwd: string, opts: ExcludableStubsOptions = {}): string[] {
  const isTracked = opts.isTracked ?? (() => false);
  const probe = opts.probe ?? defaultStubProbe;
  const fileStubs = opts.fileStubs ?? DANGEROUS_FILE_STUBS;
  const dirStubs = opts.dirStubs ?? DANGEROUS_DIR_STUBS;

  const entries: string[] = [];

  for (const name of fileStubs) {
    const abs = resolve(cwd, name);
    if (isTracked(abs)) continue;
    const kind = probe(abs);
    if (kind === 'absent' || kind === 'empty-file') entries.push(`/${name}`);
  }

  for (const name of dirStubs) {
    const abs = resolve(cwd, name);
    if (isTracked(abs)) continue;
    const kind = probe(abs);
    if (kind === 'absent' || kind === 'empty-dir') entries.push(`/${name}/`);
  }

  return entries;
}
