/**
 * Map a `tool_call` event for one of the captured tools to the set of file
 * paths it will touch, so the checkpoint hook can read each file's `before`
 * content before the tool mutates it.
 *
 *   - `write` / `edit` → a single `{ path }` (read from `input.path`,
 *     matching `filesystem.ts`' `getPathInput`). The file survives the
 *     write, so `removed` is false.
 *   - `apply_patch` → every path the patch affects, via {@link patchAffectedPaths};
 *     Delete ops and Move sources are flagged `removed` so the hook records
 *     their `after` as `null`.
 *
 * The tool `input` is typed `unknown` (it crosses the pi boundary) and is
 * defensively narrowed here, so a malformed call yields `[]` rather than
 * throwing out of the hook. No pi imports.
 */

import { patchAffectedPaths } from './patch-paths.ts';
import type { CaptureTool } from './types.ts';

/** One path a tool call will touch, flagged if the op removes the file. */
export interface CapturePath {
  path: string;
  /** True when the op deletes the file (Delete / Move source) ⇒ `after: null`. */
  removed: boolean;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Paths to snapshot for a `tool_call` of `tool` with the given raw `input`.
 * Returns `[]` for an input shape that doesn't match the tool (defensive;
 * the real tool would reject it too).
 */
export function capturePaths(tool: CaptureTool, input: unknown): CapturePath[] {
  if (typeof input !== 'object' || input === null) return [];
  const obj = input as Record<string, unknown>;

  if (tool === 'write' || tool === 'edit') {
    const path = asString(obj.path);
    return path === undefined ? [] : [{ path, removed: false }];
  }

  // apply_patch
  const patch = asString(obj.patch);
  if (patch === undefined) return [];
  return patchAffectedPaths(patch).map((p) => ({ path: p.path, removed: p.removed }));
}
