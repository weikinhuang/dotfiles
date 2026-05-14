/**
 * Resolve `writeRoots` entries from a mode file into absolute paths.
 *
 * Pure module — no pi imports — so it stays unit-testable.
 *
 * Per `plans/pi-mode-extension.md` (D8), this resolver operates on
 * path strings only and never calls `realpath`. The link path wins:
 * if a user lists a symlinked directory in `writeRoots`, the matcher
 * sees the link path, not the target. That's deliberate and is the
 * lock that keeps mode boundaries predictable.
 *
 * Substitution rules:
 *   - `~` / `~/...` → `<homedir>/...`
 *   - `{projectSlug}` substituted anywhere in the string
 *   - leading `./` stripped before resolving against cwd
 *   - absolute paths returned as-is (after tilde expansion)
 *   - relative paths resolved against `ctx.cwd`
 *   - trailing slash preserved (matcher uses it for prefix-trap defense)
 */

import { isAbsolute, resolve as pathResolve } from 'node:path';

export interface ResolveContext {
  cwd: string;
  homedir: string;
  projectSlug: string;
}

function expandTilde(input: string, homedir: string): string {
  if (input === '~') return homedir;
  if (input.startsWith('~/')) return `${homedir}/${input.slice(2)}`;
  return input;
}

function substituteSlug(input: string, projectSlug: string): string {
  if (!input.includes('{projectSlug}')) return input;
  return input.split('{projectSlug}').join(projectSlug);
}

function resolveOne(rawEntry: string, ctx: ResolveContext): string {
  // 1) substitute placeholders + tilde expansion (string ops only)
  const slugged = substituteSlug(rawEntry, ctx.projectSlug);
  let expanded = expandTilde(slugged, ctx.homedir);

  // 2) strip a single leading './' for cwd-relative entries
  if (expanded.startsWith('./')) {
    expanded = expanded.slice(2);
  }

  // 3) remember whether the substituted (pre-resolve) string ended in '/'
  //    — `path.resolve` strips trailing slashes, but the matcher relies
  //    on this convention, so we re-append.
  const hadTrailingSlash = expanded.length > 1 && expanded.endsWith('/');

  // 4) resolve against cwd if relative; keep absolute paths as-is.
  const resolved = isAbsolute(expanded) ? pathResolve(expanded) : pathResolve(ctx.cwd, expanded);

  if (hadTrailingSlash && !resolved.endsWith('/')) {
    return `${resolved}/`;
  }
  return resolved;
}

export function resolveWriteRoots(roots: readonly string[], ctx: ResolveContext): string[] {
  if (roots.length === 0) return [];
  const out: string[] = [];
  for (const r of roots) {
    if (typeof r !== 'string' || r.length === 0) continue;
    out.push(resolveOne(r, ctx));
  }
  return out;
}
