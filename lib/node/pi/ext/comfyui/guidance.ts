/**
 * Shared guidance-file reader for the comfyui enhancer and refiner wirings.
 *
 * Both the prompt enhancer ({@link ./enhancer.ts}) and the auto-refine critic
 * ({@link ./refiner.ts}) concatenate a global guidance doc followed by a
 * per-workflow one, each resolved like a workflow `file` (`~` / absolute /
 * relative-to-cwd). A missing or unreadable file is skipped silently -
 * guidance is advisory and must never block a render. This helper is the one
 * definition they both delegate to so the two never drift.
 *
 * Lives under `ext/` alongside its only callers (it touches `node:fs` +
 * `node:os` + `path-expand`, no pi runtime), so it stays testable without the
 * pi harness.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { expandTilde } from '../../path-expand.ts';

/**
 * Read + concatenate the given guidance files in order, skipping any that are
 * absent / empty / unreadable, and joining the surviving trimmed bodies with a
 * blank line. Each entry resolves like a workflow `file`. Never throws.
 */
export function readGuidanceFiles(files: readonly (string | undefined)[], fromCwd: string): string {
  const readOne = (file: string | undefined): string => {
    if (file === undefined || file.trim().length === 0) return '';
    try {
      const resolved = resolve(fromCwd, expandTilde(file, homedir()));
      if (!existsSync(resolved)) return '';
      return readFileSync(resolved, 'utf8').trim();
    } catch {
      return '';
    }
  };
  return files
    .map(readOne)
    .filter((s) => s.length > 0)
    .join('\n\n');
}
