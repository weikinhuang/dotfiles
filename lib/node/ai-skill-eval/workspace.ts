// Iteration-directory layout for ai-skill-eval (R3.3).
//
// Each `ai-skill-eval run` writes to `<workspace>/<skill>/iteration-<N>/`
// where N monotonically increases, so a skill's history is preserved and
// `report`/`benchmark` can diff across iterations. This module is the
// single source of truth for:
//
//   - resolving the next iteration slot to write into (`nextIteration`),
//   - looking up the latest existing iteration for read-side commands
//     (`latestIteration`),
//   - building a full iteration directory path (`iterationPath`),
//   - enumerating existing iterations (`listIterations`),
//   - cleaning up pre-R3.3 flat-layout subdirs so the first R3.3 `run`
//     can drop a pristine `iteration-1/` (`cleanLegacyFlat`),
//   - maintaining the best-effort `latest` symlink (`writeLatestSymlink`).
//
// All helpers are pure-ish (only fs + path) and unit-tested by
// `tests/lib/node/ai-skill-eval/workspace.spec.ts`.
//
// SPDX-License-Identifier: MIT

import { existsSync, lstatSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Prefix of every iteration subdirectory, e.g. `iteration-3`. */
export const ITERATION_PREFIX = 'iteration-';

/** Symlink name under the skill workspace that points at the latest iteration. */
export const LATEST_LINK = 'latest';

/** Parse an `iteration-N` basename into N, or null when it doesn't match. */
export function parseIterationName(name: string): number | null {
  const m = /^iteration-(\d+)$/.exec(name);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/** Absolute path of `<workspace>/<skill>/iteration-<N>`. */
export function iterationPath(workspace: string, skill: string, n: number): string {
  return join(workspace, skill, `${ITERATION_PREFIX}${n}`);
}

/** Absolute path of `<workspace>/<skill>`. */
export function skillWorkspace(workspace: string, skill: string): string {
  return join(workspace, skill);
}

/**
 * List every existing iteration subdirectory number under `<workspace>/<skill>/`,
 * sorted ascending. Returns `[]` when the skill workspace doesn't exist yet.
 */
export function listIterations(workspace: string, skill: string): number[] {
  const dir = skillWorkspace(workspace, skill);
  if (!existsSync(dir)) return [];
  const out: number[] = [];
  for (const name of readdirSync(dir)) {
    const n = parseIterationName(name);
    if (n == null) continue;
    try {
      if (statSync(join(dir, name)).isDirectory()) out.push(n);
    } catch {
      // ignore races where the dir vanished between readdir and stat
    }
  }
  return out.sort((a, b) => a - b);
}

/** Highest iteration number, or null when no iteration has landed yet. */
export function latestIteration(workspace: string, skill: string): number | null {
  const list = listIterations(workspace, skill);
  return list.length > 0 ? (list[list.length - 1] ?? null) : null;
}

/**
 * The iteration slot the next `run` should write into: `latest + 1`, or `1`
 * when the skill has no iterations yet.
 */
export function nextIteration(workspace: string, skill: string): number {
  return (latestIteration(workspace, skill) ?? 0) + 1;
}

/**
 * Pre-R3.3 flat-layout directory names that may linger when a user upgrades
 * a workspace that was written by an earlier version. We purge these so the
 * first R3.3 `run` drops a pristine `iteration-1/` with no orphaned siblings.
 * Includes the pre-R2 `prompts/` / `results/` / `grades/` trio as well as the
 * R2-era `with_skill/` / `without_skill/` config subtrees and the R3.2-era
 * `benchmark.{json,md}` artifacts.
 */
const LEGACY_FLAT_ENTRIES: readonly string[] = [
  'with_skill',
  'without_skill',
  'prompts',
  'results',
  'grades',
  'benchmark.json',
  'benchmark.md',
];

/**
 * Remove pre-R3.3 flat-layout files and subdirs from `<workspace>/<skill>/`.
 * No-op when the skill workspace has no legacy entries. Iteration subdirs
 * (`iteration-N/`) are never touched — only the sibling legacy entries are.
 */
export function cleanLegacyFlat(workspace: string, skill: string): void {
  const dir = skillWorkspace(workspace, skill);
  if (!existsSync(dir)) return;
  for (const entry of LEGACY_FLAT_ENTRIES) {
    const p = join(dir, entry);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}

/**
 * Best-effort `<workspace>/<skill>/latest` symlink pointing at `iteration-<n>`.
 * Uses a relative target so the link survives a workspace move. Silently
 * no-ops when the platform rejects symlinks (e.g. non-admin Windows), so
 * the rest of the command flow is unaffected.
 */
export function writeLatestSymlink(workspace: string, skill: string, n: number): void {
  const dir = skillWorkspace(workspace, skill);
  if (!existsSync(dir)) return;
  const linkPath = join(dir, LATEST_LINK);

  // Remove any existing link (or regular file with that name) before relinking.
  try {
    if (existsSync(linkPath) || lstatSync(linkPath).isSymbolicLink()) {
      try {
        unlinkSync(linkPath);
      } catch {
        rmSync(linkPath, { force: true, recursive: false });
      }
    }
  } catch {
    // lstat on a non-existent path is fine; keep going.
  }

  try {
    symlinkSync(`${ITERATION_PREFIX}${n}`, linkPath, 'dir');
  } catch {
    // No-op on platforms that can't symlink without elevation.
  }
}
