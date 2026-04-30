/**
 * Pure helpers for config/pi/extensions/subdir-agents.ts.
 *
 * This module intentionally has zero dependencies on @mariozechner/pi-coding-agent
 * so it can be imported and unit-tested under `vitest` without any
 * TypeScript toolchain or pi runtime.
 *
 * "Subdir AGENTS.md" = Claude Code / Codex / opencode-style lazy discovery of
 * `AGENTS.md` and `CLAUDE.md` files in subdirectories of the workspace when
 * the model accesses a file in that subtree. Pi's built-in loader only walks
 * UP from cwd at startup, so nested context files (e.g. `tests/AGENTS.md`)
 * are never picked up automatically.
 */

import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export const DEFAULT_CONTEXT_FILE_NAMES: readonly string[] = ['AGENTS.md', 'CLAUDE.md'];

// ──────────────────────────────────────────────────────────────────────
// Candidate discovery
// ──────────────────────────────────────────────────────────────────────

/**
 * Normalize a cwd or file path to an absolute, resolved path with any
 * trailing separator stripped. Relative inputs are resolved against
 * `process.cwd()` — callers that already know their absolute cwd should
 * pass absolute paths to stay hermetic.
 */
export function normalizeAbs(p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(p);
  if (abs.length > 1 && abs.endsWith(sep)) return abs.slice(0, -sep.length);
  return abs;
}

/**
 * Return `true` if `absFilePath` is inside `absCwd` (or equals it).
 * Uses lexical `path.relative` — does NOT follow symlinks. A path
 * exactly equal to `absCwd` counts as inside.
 */
export function isInsideCwd(absFilePath: string, absCwd: string): boolean {
  if (absFilePath === absCwd) return true;
  const rel = relative(absCwd, absFilePath);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false; // different drive on Windows
  return true;
}

/**
 * List absolute candidate context-file paths to check when the model
 * accesses `filePath`, in deepest-first order.
 *
 * Walks `dirname(filePath)` upward. The walk starts at the file's
 * directory (so a file in `tests/unit/foo.ts` checks `tests/unit/` and
 * `tests/`) and stops after visiting `cwd` (so the workspace-root
 * `AGENTS.md` is included — it'll almost always already be in the
 * loaded-set, but making the walk inclusive keeps the pure helper
 * symmetric and obvious).
 *
 * If `filePath` is outside `cwd`, returns an empty list. That's the
 * deliberate scope choice: pi's startup already walks UP from cwd, and
 * this extension fills in the DOWNWARD direction — not sideways into
 * other repos.
 *
 * The returned list contains one entry per (directory, filename) pair in
 * the order directories are visited (deepest first), and within each
 * directory in the order `fileNames` was passed. No existence check is
 * performed — that's the caller's job.
 */
export function candidateContextPaths(
  filePath: string,
  cwd: string,
  fileNames: readonly string[] = DEFAULT_CONTEXT_FILE_NAMES,
): string[] {
  const absFile = normalizeAbs(filePath);
  const absCwd = normalizeAbs(cwd);
  if (!isInsideCwd(absFile, absCwd)) return [];
  if (fileNames.length === 0) return [];

  const out: string[] = [];
  const seenDirs = new Set<string>();
  // Start at dirname(file). If the file IS cwd (unlikely — cwd is a
  // directory), dirname steps to its parent, which isInsideCwd rejects.
  let dir = dirname(absFile);
  // Guard: if the caller accidentally passed a directory as `filePath`
  // (e.g. cwd itself), treat the directory as the starting point so we
  // still visit it.
  if (absFile === absCwd) dir = absCwd;

  while (isInsideCwd(dir, absCwd)) {
    if (seenDirs.has(dir)) break; // filesystem root reached
    seenDirs.add(dir);
    for (const name of fileNames) {
      out.push(resolve(dir, name));
    }
    if (dir === absCwd) break;
    const parent = dirname(dir);
    if (parent === dir) break; // hit filesystem root before cwd
    dir = parent;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Injection message formatting
// ──────────────────────────────────────────────────────────────────────

export interface LoadedContextFile {
  /** Absolute path the content was read from. */
  path: string;
  /** Raw file contents (already size-capped if the caller chose to cap). */
  content: string;
  /** `true` if `content` was truncated from the on-disk file. */
  truncated?: boolean;
}

/**
 * Format a user-visible path for display in the injected message. If
 * `absPath` is inside `cwd`, returns a relative path; otherwise returns
 * `absPath` unchanged. Normalizes Windows separators to forward slashes
 * for consistent LLM output.
 */
export function displayPath(absPath: string, cwd: string): string {
  const absCwd = normalizeAbs(cwd);
  const abs = normalizeAbs(absPath);
  if (!isInsideCwd(abs, absCwd)) return abs.split(sep).join('/');
  if (abs === absCwd) return '.';
  const rel = relative(absCwd, abs);
  return rel.split(sep).join('/');
}

/**
 * Build the steered-message content announcing one or more newly
 * discovered context files to the model. Files are rendered in the
 * order given — callers typically pass shallowest-first so the model
 * reads parent guidance before child overrides, but that's a style
 * choice, not a correctness requirement.
 */
export function formatContextInjection(files: readonly LoadedContextFile[], cwd: string): string {
  if (files.length === 0) return '';
  const lines: string[] = [];
  const plural = files.length === 1 ? '' : 's';
  const list = files.map((f) => `\`${displayPath(f.path, cwd)}\``).join(', ');
  lines.push(`**Subdirectory context file${plural} discovered:** ${list}`);
  lines.push('');
  lines.push(
    'You just accessed files under a subdirectory with its own `AGENTS.md` / `CLAUDE.md`. ' +
      'These instructions apply to work in that subtree and supplement — not replace — the ' +
      'project-root context already loaded at startup.',
  );
  lines.push('');
  for (const f of files) {
    const displayed = displayPath(f.path, cwd);
    lines.push(`<context file="${displayed}">`);
    lines.push(f.content.replace(/\r\n/g, '\n'));
    if (f.truncated) {
      lines.push('');
      lines.push(`[truncated — read \`${displayed}\` directly with the read tool for the full file]`);
    }
    lines.push('</context>');
    lines.push('');
  }
  // Trim the trailing blank line.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Size capping
// ──────────────────────────────────────────────────────────────────────

/**
 * Default cap for a single context file's content, in bytes. Large
 * AGENTS.md files are rare but possible (this repo's root one is ~7 KB).
 * The cap exists to stop a runaway file from blowing the LLM's context
 * window, not to enforce a hard rule — the model can always re-read the
 * file directly with the `read` tool.
 */
export const DEFAULT_CONTEXT_FILE_BYTE_CAP = 16 * 1024;

/**
 * Truncate `content` to at most `cap` bytes (UTF-8). Returns the possibly
 * truncated string and a flag indicating whether truncation occurred. Cuts
 * at a UTF-8 code-point boundary so the output is always valid UTF-8.
 */
export function capContent(content: string, cap: number): { content: string; truncated: boolean } {
  if (cap <= 0) return { content: '', truncated: content.length > 0 };
  const buf = Buffer.from(content, 'utf8');
  if (buf.byteLength <= cap) return { content, truncated: false };
  // Walk backward from `cap` to the nearest start-of-codepoint byte.
  let end = cap;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { content: buf.subarray(0, end).toString('utf8'), truncated: true };
}
