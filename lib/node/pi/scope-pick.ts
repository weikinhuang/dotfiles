/**
 * Shared "pick project vs user scope" helper for `/X-allow` / `/X-deny`
 * style slash commands that write back into `~/.pi/<file>.json` or
 * `<repo>/.pi/<file>.json`.
 *
 * Rule (matches the pattern in `bash-permissions.ts`, `filesystem.ts`,
 * `sandbox.ts`):
 *
 *   - If the project-scope file already exists, write to it.
 *   - Otherwise, if a `.pi/` directory exists in cwd, treat the project
 *     as "configured" and write to the project file.
 *   - Otherwise fall back to the user-scope file.
 *
 * Pure module - no pi imports.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

export interface ScopePickOptions {
  cwd: string;
  /** Absolute path to the project-scope file (e.g.
   *  `<cwd>/.pi/sandbox.json`). */
  projectFile: string;
  /** Absolute path to the user-scope file (e.g.
   *  `~/.pi/sandbox.json`). */
  userFile: string;
}

/**
 * Pick the file the next write should go to. Existence checks are
 * best-effort - a stat failure for any reason falls through to the
 * next option.
 */
export function pickScopeFile(opts: ScopePickOptions): string {
  const { cwd, projectFile, userFile } = opts;
  try {
    if (statSync(projectFile).isFile()) return projectFile;
  } catch {
    // fall through
  }
  try {
    if (statSync(join(cwd, '.pi')).isDirectory()) return projectFile;
  } catch {
    // fall through
  }
  return userFile;
}
