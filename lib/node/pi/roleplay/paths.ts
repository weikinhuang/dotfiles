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

import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile, ensureDirSync } from '../atomic-write.ts';
import { piAgentPath } from '../pi-paths.ts';
import {
  parseFrontmatter,
  renderIndexMd,
  ROLEPLAY_KINDS,
  type RoleplayEntry,
  type RoleplayKind,
  type RoleplayState,
} from './store.ts';

export { atomicWriteFile, ensureDirSync };

/** Absolute path to the roleplay store root, honouring `PI_ROLEPLAY_ROOT`
 * (and `PI_CODING_AGENT_DIR` for the default via `piAgentPath`). */
export function roleplayRoot(): string {
  const env = process.env.PI_ROLEPLAY_ROOT;
  if (env && env.trim().length > 0) return env.trim();
  return piAgentPath('roleplay');
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

// ──────────────────────────────────────────────────────────────────────
// Per-cast carry-over + newscene archive layout (recap + timeline)
//
// The within-session / resume / fork store is pi's SESSION BRANCH (custom
// recap + timeline audit entries travel with the tree and carry the exact
// coverage boundary), so the redundant `sessions/<sid>.md` live tier is
// retired. A kind dir keeps two file locations:
//
//   <cast>/<kind>/auto.md            carry-over (scanned entry; cross-session seed for new trees)
//   <cast>/<kind>/archive/<ts>.md    newscene-archived prior carry-overs
//
// `scanCast` only reads top-level `*.md` in each kind dir, so the
// `archive/` subdir files are already skipped - no scanCast change needed.
// ──────────────────────────────────────────────────────────────────────

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

/** Directory holding a kind's newscene-archived carry-overs. */
export function archiveDir(cast: string, kind: RoleplayKind, root: string = roleplayRoot()): string {
  return join(kindDir(cast, kind, root), 'archive');
}

/** Path to a newscene-archived carry-over for one kind (`<kind>/archive/<ts>.md`). */
export function archiveFile(cast: string, kind: RoleplayKind, ts: string, root: string = roleplayRoot()): string {
  return join(archiveDir(cast, kind, root), `${ts}.md`);
}

/**
 * Move a kind's carry-over `auto.md` to `<kind>/archive/<ts>.md` (newscene
 * boundary). Returns `true` when a carry-over existed and was moved.
 * Best-effort: a failure returns `false` without throwing.
 */
export function archiveCarryOver(cast: string, kind: RoleplayKind, ts: string, root: string = roleplayRoot()): boolean {
  const src = fileFor(cast, kind, 'auto', root);
  if (!existsSync(src)) return false;
  try {
    const dest = archiveFile(cast, kind, ts, root);
    ensureDirSync(archiveDir(cast, kind, root));
    renameSync(src, dest);
    return true;
  } catch {
    return false;
  }
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

// ──────────────────────────────────────────────────────────────────────
// Captured-facts carry-over sidecar (`<cast>/facts/<slug>.md`)
//
// NOT a `RoleplayKind`: `scanCast` never touches `facts/`, and it is never
// injected via `formatRoleplayBlock`. The loader reads this dir directly on
// a new session and seeds the facts into the coding-`memory` note tier (the
// single existing injection path). Files reuse `serializeEntry` framing with
// a `kind: summary` marker purely so the shared frontmatter parser round-
// trips them; the marker is inert because the dir is unscanned.
// ──────────────────────────────────────────────────────────────────────

/** Directory holding a cast's carry-over fact sidecars. */
export function factsDir(cast: string, root: string = roleplayRoot()): string {
  return join(castDir(cast, root), 'facts');
}

/** Path to one carry-over fact sidecar (`facts/<slug>.md`). */
export function factFile(cast: string, slug: string, root: string = roleplayRoot()): string {
  return join(factsDir(cast, root), `${slug}.md`);
}

/** Directory a newscene run archives the current fact sidecars into. */
export function factsArchiveDir(cast: string, ts: string, root: string = roleplayRoot()): string {
  return join(factsDir(cast, root), 'archive', ts);
}

/** One carry-over fact: header-carried name + description (no body needed). */
export interface FactSidecar {
  slug: string;
  name: string;
  description: string;
}

/**
 * Read every carry-over fact sidecar for a cast (`facts/*.md`, top-level
 * only - the `archive/` subdir is skipped). Malformed files are dropped
 * silently. Sorted by slug for determinism.
 */
export function listFactSidecars(cast: string, root: string = roleplayRoot()): FactSidecar[] {
  const dir = factsDir(cast, root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: FactSidecar[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    const raw = readTextFile(full);
    if (raw == null) continue;
    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;
    out.push({ slug: name.slice(0, -3), name: parsed.frontmatter.name, description: parsed.frontmatter.description });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

/**
 * Archive all carry-over fact sidecars into `facts/archive/<ts>/` and clear
 * the live sidecar set (newscene boundary). Best-effort per file; returns
 * the number moved.
 */
export function archiveFacts(cast: string, ts: string, root: string = roleplayRoot()): number {
  const dir = factsDir(cast, root);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return 0;
  }
  if (names.length === 0) return 0;
  const dest = factsArchiveDir(cast, ts, root);
  ensureDirSync(dest);
  let moved = 0;
  for (const name of names) {
    try {
      renameSync(join(dir, name), join(dest, name));
      moved += 1;
    } catch {
      /* best-effort */
    }
  }
  return moved;
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
