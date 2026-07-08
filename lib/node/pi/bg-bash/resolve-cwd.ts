/**
 * Resolve the `start` action's working directory.
 *
 * Pure - the home directory is passed in rather than read from
 * `os.homedir()` so callers stay deterministic under vitest. Mirrors the
 * historical extension behaviour exactly:
 *   - no `cwd` supplied            -> the agent cwd
 *   - absolute (`/…`)              -> returned verbatim (no normalization)
 *   - leading `~` / `~/`           -> expanded against `home`, then normalized
 *   - anything else (relative)     -> joined onto the agent cwd
 *
 * `~user/` is not expanded (see path-expand); such an input falls through
 * to the relative branch, matching the original.
 */

import { join } from 'node:path';

import { expandTilde } from '../path-expand.ts';

export function resolveCwd(agentCwd: string, supplied: string | undefined, home: string): string {
  if (!supplied) return agentCwd;
  if (supplied.startsWith('/')) return supplied;
  // Leading `~` / `~/` expands against the real home; `join` normalizes so
  // the resolved path matches the previous hand-rolled `join(homedir(), …)`.
  const expanded = expandTilde(supplied, home);
  if (expanded !== supplied) return join(expanded);
  return join(agentCwd, supplied);
}
