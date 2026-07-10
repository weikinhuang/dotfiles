/**
 * Parse + resolve the `PI_PERSONA_DIRS` env override for the persona
 * extension (`config/pi/extensions/persona.ts`).
 *
 * Pure module - no pi imports - so it stays unit-testable under vitest.
 *
 * `PI_PERSONA_DIRS` is a colon-separated list of extra persona
 * directories, searched at HIGHEST precedence (appended after the
 * project layer, so later-wins puts them last). Each entry points at a
 * directory that directly contains persona `*.md` files, not a parent.
 * Handy for test / eval personas that shouldn't live in the standard
 * shipped / user / project dirs.
 *
 * Resolution mirrors `resolve.ts`:
 *   - leading `~` / `~/...` expands against `homedir`
 *   - a single leading `./` is stripped
 *   - absolute paths pass through as-is
 *   - relative paths resolve against `cwd`
 *
 * Unlike `writeRoots`, there is no `{projectSlug}` substitution and no
 * trailing-slash preservation - these are directory paths handed to
 * `readdirSync`, not prefix-match roots.
 */

import { isAbsolute, resolve as pathResolve } from 'node:path';

import { expandTilde } from '../path-expand.ts';

export interface PersonaEnvDirContext {
  cwd: string;
  homedir: string;
}

/**
 * Split the raw `PI_PERSONA_DIRS` value on `:`, trim each entry, and
 * drop empties. Returns `[]` for `undefined` / empty / whitespace-only
 * input so an unset env var is a no-op.
 */
export function parsePersonaDirsEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve one persona dir entry to an absolute path. Tilde-expands,
 * strips a single leading `./`, and resolves relative entries against
 * `cwd`; absolute paths pass through.
 */
export function resolvePersonaEnvDir(entry: string, ctx: PersonaEnvDirContext): string {
  let expanded = expandTilde(entry, ctx.homedir);
  if (expanded.startsWith('./')) {
    expanded = expanded.slice(2);
  }
  return isAbsolute(expanded) ? pathResolve(expanded) : pathResolve(ctx.cwd, expanded);
}

/**
 * Build the ordered list of resolved `env`-source persona dirs from a
 * pre-split entry list. Each element is ready to append to the persona
 * layer array (last-wins precedence).
 */
export function buildPersonaEnvDirs(entries: readonly string[], ctx: PersonaEnvDirContext): string[] {
  return entries.map((e) => resolvePersonaEnvDir(e, ctx));
}
