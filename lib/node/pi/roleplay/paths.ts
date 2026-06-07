/**
 * Filesystem layout + disk I/O for the `roleplay` extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * The store is keyed by *cast* slug - a roleplay scenario travels across
 * workspaces, unlike coding `memory` which keys on cwd/session.
 *
 *   <root>/
 *     casts/<cast-slug>/
 *       INDEX.md
 *       character/<slug>.md
 *
 * `<root>` defaults to `~/.pi/agent/roleplay`, overridable via
 * `PI_ROLEPLAY_ROOT`. The coding `memory` tree (`~/.pi/agent/memory`) is
 * a sibling and is never touched by this extension.
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFile, ensureDirSync } from '../atomic-write.ts';
import {
  parseFrontmatter,
  renderIndexMd,
  ROLEPLAY_KINDS,
  type RoleplayEntry,
  type RoleplayKind,
  type RoleplayState,
} from './store.ts';

export { atomicWriteFile, ensureDirSync };

/** Absolute path to the roleplay store root, honouring `PI_ROLEPLAY_ROOT`. */
export function roleplayRoot(): string {
  const env = process.env.PI_ROLEPLAY_ROOT;
  if (env && env.trim().length > 0) return env.trim();
  return join(homedir(), '.pi', 'agent', 'roleplay');
}

export function castsParentDir(root: string = roleplayRoot()): string {
  return join(root, 'casts');
}

export function castDir(cast: string, root: string = roleplayRoot()): string {
  return join(castsParentDir(root), cast);
}

export function kindDir(cast: string, kind: RoleplayKind, root: string = roleplayRoot()): string {
  return join(castDir(cast, root), kind);
}

export function fileFor(cast: string, kind: RoleplayKind, slug: string, root: string = roleplayRoot()): string {
  return join(kindDir(cast, kind, root), `${slug}.md`);
}

export function indexFileFor(cast: string, root: string = roleplayRoot()): string {
  return join(castDir(cast, root), 'INDEX.md');
}

/**
 * Path to a character's portrait PNG (`<cast>/portraits/<slug>.png`).
 * Optional art the avatar shows in place of its animated sprite when the
 * file exists (Phase 6B); the store never writes here - the user drops
 * art in. Scene illustrations (Phase 6C) live under `<cast>/scenes/`.
 */
export function portraitPath(cast: string, slug: string, root: string = roleplayRoot()): string {
  return join(castDir(cast, root), 'portraits', `${slug}.png`);
}

export function removeFileIfExists(path: string): boolean {
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function readEntryBody(cast: string, entry: RoleplayEntry, root: string = roleplayRoot()): string | null {
  const path = fileFor(cast, entry.kind, entry.id, root);
  if (!existsSync(path)) return null;
  const raw = readTextFile(path);
  if (raw == null) return null;
  const parsed = parseFrontmatter(raw);
  return parsed ? parsed.body : raw;
}

export interface ScanWarning {
  path: string;
  reason: string;
}

/**
 * Walk `<castDir>/<kind>/*.md` for each known kind and parse frontmatter
 * into `RoleplayEntry` records. Malformed files are skipped with a
 * warning so one bad file doesn't blind the whole cast.
 */
export function scanCast(
  cast: string,
  root: string = roleplayRoot(),
): { entries: RoleplayEntry[]; warnings: string[] } {
  const entries: RoleplayEntry[] = [];
  const warnings: ScanWarning[] = [];
  const base = castDir(cast, root);

  for (const kind of ROLEPLAY_KINDS) {
    const dir = join(base, kind);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.md')) continue;
      const full = join(dir, name);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      const raw = readTextFile(full);
      if (raw == null) {
        warnings.push({ path: full, reason: 'unreadable' });
        continue;
      }
      const parsed = parseFrontmatter(raw);
      if (!parsed) {
        warnings.push({ path: full, reason: 'missing or malformed frontmatter' });
        continue;
      }
      if (parsed.frontmatter.kind !== kind) {
        warnings.push({
          path: full,
          reason: `frontmatter kind "${String(parsed.frontmatter.kind)}" != directory "${String(kind)}"`,
        });
        continue;
      }
      entries.push({
        id: name.slice(0, -3),
        kind,
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        ...(parsed.frontmatter.lore ? { lore: parsed.frontmatter.lore } : {}),
        ...(parsed.frontmatter.relationship ? { relationship: parsed.frontmatter.relationship } : {}),
      });
    }
  }

  entries.sort((a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`));

  return { entries, warnings: warnings.map((w) => `${w.path}: ${w.reason}`) };
}

/** Rebuild the in-memory state for a cast from disk. */
export function rebuildCast(cast: string, root: string = roleplayRoot()): { state: RoleplayState; warnings: string[] } {
  const { entries, warnings } = scanCast(cast, root);
  return { state: { cast, entries }, warnings };
}

/** (Re)write a cast's `INDEX.md` from its current state. */
export function writeIndex(state: RoleplayState, root: string = roleplayRoot()): void {
  atomicWriteFile(indexFileFor(state.cast, root), renderIndexMd(state));
}

/** List the cast slugs that currently have a directory under the root. */
export function listCasts(root: string = roleplayRoot()): string[] {
  let names: string[];
  try {
    names = readdirSync(castsParentDir(root));
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      try {
        return statSync(join(castsParentDir(root), name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}
