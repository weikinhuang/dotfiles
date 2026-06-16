/**
 * Enumerate the file paths a Codex-format `apply_patch` call would touch,
 * by reusing the existing patch parser (`apply-patch/parse.ts`) rather than
 * re-scanning headers. One patch can Add / Update / Delete / Move several
 * files; the checkpoint hook needs every affected path so it can snapshot
 * each file's `before` content pre-execution.
 *
 * A `Move` touches BOTH ends: the source (which is deleted) and the
 * destination (which is created), so both are captured.
 *
 * No pi imports - pure over the parsed patch.
 */

import { parsePatch } from '../apply-patch/parse.ts';

/** One path the patch affects, tagged with whether the op removes it. */
export interface PatchPath {
  path: string;
  /** True for the source of a Move and for a Delete (the file goes away). */
  removed: boolean;
}

/**
 * Parse `patch` and return the distinct paths it touches. Returns `[]` when
 * the patch is malformed (the real `apply_patch` tool will reject it and the
 * `tool_result` hook discards the provisional snapshot), so a parse failure
 * never throws out of the capture hook.
 */
export function patchAffectedPaths(patch: string): PatchPath[] {
  const result = parsePatch(patch);
  if ('error' in result) return [];

  const out: PatchPath[] = [];
  const seen = new Set<string>();
  const add = (path: string, removed: boolean): void => {
    const key = `${path}\0${removed ? '1' : '0'}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, removed });
  };

  for (const op of result.patch.ops) {
    switch (op.type) {
      case 'add':
        add(op.path, false);
        break;
      case 'update':
        add(op.path, false);
        break;
      case 'delete':
        add(op.path, true);
        break;
      case 'move':
        add(op.from, true); // source removed
        add(op.to, false); // destination created
        break;
    }
  }
  return out;
}
