/**
 * Path normalization + display-friendly rendering. Pure helpers shared
 * across extensions that need to show a model-visible relative path
 * while keeping out-of-tree paths absolute.
 *
 * Several extensions used to keep byte-identical 7-line copies of a
 * simplified `displayPath`. Consolidating here gives one Windows-safe
 * implementation and lets the underlying `isInsideCwd` /  `normalizeAbs`
 * helpers be reused by callers that need to gate on "inside vs outside
 * cwd" (e.g. subdir-agents).
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Normalize a cwd or file path to an absolute, resolved path with any
 * trailing separator stripped. Relative inputs are resolved against
 * `process.cwd()` - callers that already know their absolute cwd should
 * pass absolute paths to stay hermetic.
 */
export function normalizeAbs(p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(p);
  if (abs.length > 1 && abs.endsWith(sep)) return abs.slice(0, -sep.length);
  return abs;
}

/**
 * Return `true` if `absFilePath` is inside `absCwd` (or equals it).
 * Uses lexical `path.relative` - does NOT follow symlinks. A path
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
 * Format a user-visible path for display in injected messages. If
 * `absPath` is inside `cwd`, returns a relative path; otherwise returns
 * the absolute path unchanged. Normalizes Windows separators to forward
 * slashes for consistent LLM output.
 */
export function displayPath(absPath: string, cwd: string): string {
  const absCwd = normalizeAbs(cwd);
  const abs = normalizeAbs(absPath);
  if (!isInsideCwd(abs, absCwd)) return abs.split(sep).join('/');
  if (abs === absCwd) return '.';
  const rel = relative(absCwd, abs);
  return rel.split(sep).join('/');
}
