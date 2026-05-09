// Skill + evals discovery for ai-skill-eval.
// SPDX-License-Identifier: MIT

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { type EvalsFile, type SkillEntry } from './types.ts';

export const DEFAULT_SCAN_ROOTS = [
  '.agents/skills',
  'config/agents/skills',
  'config/pi/skills',
  '.claude/skills',
] as const;

/** Return true if the path exists and is a directory. */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Return true if the path is a real (non-symlink) directory. Matches the
 * bash original's `find <root>` semantics, which does not descend through
 * symlinked roots without `-L`.
 */
function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Walk `root` recursively, returning all `SKILL.md` paths in sorted order. */
export function findSkillMdFiles(root: string): string[] {
  if (!isRealDir(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Discover skill entries across one or more scan roots. Deduplicates by SKILL.md path. */
export function discoverSkills(roots: readonly string[]): SkillEntry[] {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const root of roots) {
    for (const skillMd of findSkillMdFiles(root)) {
      if (seen.has(skillMd)) continue;
      seen.add(skillMd);
      const dir = dirname(skillMd);
      const parts = dir.split(sep);
      const name = parts[parts.length - 1] ?? dir;
      const evalsJson = join(dir, 'evals', 'evals.json');
      out.push({
        name,
        skillMd,
        evalsJson: existsSync(evalsJson) ? evalsJson : null,
      });
    }
  }
  return out;
}

/** Resolve the scan roots: use the caller-provided list if set, otherwise the defaults that exist as real directories. */
export function resolveScanRoots(provided: readonly string[]): string[] {
  if (provided.length > 0) return [...provided];
  return DEFAULT_SCAN_ROOTS.filter((r) => isDir(r));
}

export function loadEvalsFile(path: string): EvalsFile {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<EvalsFile>;
  return {
    skill_name: data.skill_name,
    evals: Array.isArray(data.evals) ? data.evals : [],
  };
}

export function countEvals(path: string): number {
  try {
    return loadEvalsFile(path).evals.length;
  } catch {
    return 0;
  }
}
