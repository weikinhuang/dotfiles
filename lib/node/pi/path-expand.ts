/**
 * Shared leading-`~` expansion for config-supplied paths.
 *
 * Pure module - no pi imports, and the home directory is passed in
 * rather than read from `os.homedir()` here, so callers stay
 * deterministic under vitest and the helper has no ambient dependency.
 *
 * Only a leading `~`, `~/`, or `~\` is expanded. `~user/` is NOT
 * supported (it would need a password-db lookup), and `$HOME` is left
 * untouched - pi tools don't shell-expand env vars in paths either.
 * Anything that isn't a leading tilde falls through unchanged.
 */

import { sep } from 'node:path';

/** Expand a leading `~` / `~/` / `~\` in `path` against `homedir`. */
export function expandTilde(path: string, homedir: string): string {
  if (path === '~') return homedir;
  if (path.startsWith('~/') || path.startsWith(`~${sep}`)) return homedir + path.slice(1);
  return path;
}
