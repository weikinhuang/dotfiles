/**
 * Pure helpers for config/pi/extensions/protected-paths.ts.
 *
 * This module intentionally has zero dependencies on @mariozechner/pi-coding-agent
 * so it can be imported and unit-tested under plain `node --test` without any
 * TypeScript toolchain or pi runtime.
 */

import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type Reason = 'env-file' | 'node-modules' | 'outside-workspace' | 'extra-glob';

export interface Protection {
  reason: Reason;
  detail: string;
}

// ──────────────────────────────────────────────────────────────────────
// Path helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Handles `~`, `~/foo`, and (on Windows) `~\foo`. `~user/` is intentionally
 * NOT supported — it requires a password-db lookup and is almost never
 * emitted by an LLM. Anything else (e.g. `$HOME/foo`) is left alone; pi's
 * write/edit tools don't do shell env-var expansion either, so the literal
 * string is what would actually be written to.
 */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith(`~${sep}`)) {
    return homedir() + p.slice(1);
  }
  return p;
}

/**
 * Convert a simple glob (supporting `*` and `?`) to an anchored RegExp.
 * Everything else is escaped to be matched literally.
 */
export function globToRegex(glob: string): RegExp {
  let out = '^';
  for (const ch of glob) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

export function basenameOf(absolutePath: string): string {
  const idx = absolutePath.lastIndexOf(sep);
  return idx === -1 ? absolutePath : absolutePath.slice(idx + 1);
}

export function isInsideWorkspace(absolutePath: string, cwd: string): boolean {
  const rel = relative(cwd, absolutePath);
  // `rel` starts with `..` (or is absolute on Windows) when outside.
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`);
}

export function containsNodeModules(absolutePath: string, cwd: string): boolean {
  // Only flag node_modules segments *inside* the workspace; an external
  // path is already caught by the outside-workspace rule (and we don't
  // want to double-flag it).
  if (!isInsideWorkspace(absolutePath, cwd)) return false;
  const rel = relative(cwd, absolutePath);
  return rel.split(sep).includes('node_modules');
}

// ──────────────────────────────────────────────────────────────────────
// Classification
// ──────────────────────────────────────────────────────────────────────

/** Default basename globs that always trigger a prompt. */
export const DEFAULT_SENSITIVE_BASENAMES = ['.env', '.env.*'];

/**
 * Classify an `inputPath` (from the tool's `path` argument) relative to
 * the current workspace. Returns null when the path is safe, or a
 * {@link Protection} describing why the gate should prompt.
 *
 * The `inputPath` is tilde-expanded before being resolved, so an LLM
 * writing to `~/.env` trips the `.env` or outside-workspace rules
 * instead of silently creating a `./~/.env` directory.
 */
export function classify(inputPath: string, cwd: string, extraRegexes: RegExp[]): Protection | null {
  const absolute = resolve(cwd, expandTilde(inputPath));

  if (!isInsideWorkspace(absolute, cwd)) {
    return { reason: 'outside-workspace', detail: `Outside workspace (${cwd})` };
  }

  const base = basenameOf(absolute);
  for (const glob of DEFAULT_SENSITIVE_BASENAMES) {
    if (globToRegex(glob).test(base)) {
      return { reason: 'env-file', detail: `Sensitive file (${glob})` };
    }
  }

  if (containsNodeModules(absolute, cwd)) {
    return { reason: 'node-modules', detail: 'Inside node_modules/' };
  }

  for (const rx of extraRegexes) {
    if (rx.test(base)) {
      return {
        reason: 'extra-glob',
        detail: `Matched PI_PROTECTED_PATHS_EXTRA_GLOBS (${rx.source})`,
      };
    }
  }

  return null;
}
