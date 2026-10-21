/**
 * Track which files a child agent tried to write, so a run that stops
 * early (wall-clock timeout, turn budget, abort, error) can tell the
 * parent where partial changes may have landed.
 *
 * Pure module - no pi imports. Fed from the child's
 * `tool_execution_start` events (`toolName` + `args`) by
 * `createChildRun` in `./spawn.ts`. Paths are recorded verbatim as the
 * child passed them (relative to the child cwd, or absolute); the list
 * is "attempted writes", not a verified diff - a `bash` command can
 * still change files without showing up here.
 */

import { isRecord } from '../shared/guards.ts';

/** Tool names whose arguments name a file the child writes. */
export const FILE_WRITE_TOOL_NAMES: readonly string[] = ['write', 'edit', 'apply_patch'];

const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/;
const PATCH_MOVE_HEADER = /^\*\*\* Move File:\s*(.+?)\s*->\s*(.+?)\s*$/;

/** Extract the file paths named by an `apply_patch` envelope's op headers. */
export function pathsFromPatch(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const move = PATCH_MOVE_HEADER.exec(line);
    if (move) {
      out.push(move[1], move[2]);
      continue;
    }
    const file = PATCH_FILE_HEADER.exec(line);
    if (file) out.push(file[1]);
  }
  return out;
}

/**
 * Return the paths one tool call would write. Non-writing tools and
 * malformed args yield an empty list.
 */
export function touchedPathsFromToolCall(toolName: string | undefined, args: unknown): string[] {
  if (!toolName || !FILE_WRITE_TOOL_NAMES.includes(toolName) || !isRecord(args)) return [];
  if (toolName === 'apply_patch') {
    return typeof args.patch === 'string' ? pathsFromPatch(args.patch) : [];
  }
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  return path.length > 0 ? [path] : [];
}

/**
 * Record the paths from one tool call into `into` (insertion-ordered,
 * de-duplicated). Returns `into` for chaining.
 */
export function recordTouchedFiles(into: Set<string>, toolName: string | undefined, args: unknown): Set<string> {
  for (const p of touchedPathsFromToolCall(toolName, args)) into.add(p);
  return into;
}
