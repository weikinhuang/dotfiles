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

/** Directory holding one named lore bundle (`<cast>/lore/<bundle>/`). `bundle` may be a nested,
 * `/`-separated name (`home/loft`); `join` resolves it under `lore/`. See the bundle note below `scanCast`. */
export function loreBundleDir(cast: string, bundle: string, root: string = roleplayRoot()): string {
  return join(kindDir(cast, 'lore', root), bundle);
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
  const path = entry.bundle
    ? join(loreBundleDir(cast, entry.bundle, root), `${entry.id}.md`)
    : fileFor(cast, entry.kind, entry.id, root);
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

// ──────────────────────────────────────────────────────────────────────
// Optional lore bundles
//
// A cast's `lore/` dir holds the always-on BASE lore as top-level
// `lore/*.md`. It may ALSO hold any number of NAMED bundles -
// interchangeable groups of lore for alternate settings, seasons, story
// arcs, or any other variant axis. A bundle is a directory under `lore/`
// that directly contains `*.md`; its NAME is its path relative to
// `lore/` using `/` separators. Bundles may be flat (`lore/<name>/*.md`
// -> `<name>`) or nested under grouping dirs to arbitrary depth
// (`lore/<group>/<name>/*.md` -> `<group>/<name>`); a pure grouping dir
// with no `*.md` of its own is not itself a bundle. A bundle is INERT
// unless its name is in the activation selection passed to `scanCast`
// (resolved from `PI_ROLEPLAY_LORE_BUNDLES` in the extension layer - the
// scanner stays env-agnostic).
//
// Precedence, applied by keying every entry on `<kind>/<id>` and letting
// later writes win:
//
//   base `lore/*.md`  <  bundles[0]  <  bundles[1]  <  …
//
// i.e. an activated bundle file OVERRIDES a base file that shares its id,
// and a bundle later in the selection overrides an earlier one. Bundles
// only ever contribute `lore` entries; the other kinds have no bundle
// tier. An activated name with no matching subfolder is reported as a
// warning and skipped (graceful). Because only explicitly-selected
// bundle subfolders are read, inert bundles - and any incidental
// subfolder like `archive/` - are never scanned.
// ──────────────────────────────────────────────────────────────────────

/** Resolved, scanner-facing bundle selection (env/config parse stays in the extension layer). */
export interface ScanCastOptions {
  /**
   * Activated lore bundle names, in ASCENDING precedence order (later
   * entries override earlier ones; all override base lore). Empty /
   * omitted = base lore only.
   */
  loreBundles?: string[];
}

/**
 * Parse a `PI_ROLEPLAY_LORE_BUNDLES`-style value into an ordered bundle
 * selection: comma-separated names, trimmed, blanks dropped, duplicates
 * removed (first occurrence wins to keep precedence order stable). Pure
 * so the env/config resolution is unit-testable apart from disk I/O.
 */
export function parseLoreBundleSelection(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Parse every `*.md` in one directory as entries of a single `kind`,
 * returning the parsed records (no dedup - callers key/order them) and
 * pushing problems into `warnings`. Subdirectories are skipped (only
 * top-level files are read), so scanning a kind dir never descends into
 * its bundle / `archive/` subfolders. `bundle` stamps the runtime-only
 * source annotation onto every record read from a bundle subfolder.
 */
function readKindDir(dir: string, kind: RoleplayKind, warnings: ScanWarning[], bundle?: string): RoleplayEntry[] {
  const out: RoleplayEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
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
    out.push({
      id: name.slice(0, -3),
      kind,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      ...(parsed.frontmatter.lore ? { lore: parsed.frontmatter.lore } : {}),
      ...(parsed.frontmatter.relationship ? { relationship: parsed.frontmatter.relationship } : {}),
      ...(bundle ? { bundle } : {}),
    });
  }
  return out;
}

/**
 * List every lore bundle present on disk for a cast, sorted. A bundle is
 * any directory UNDER `lore/` that DIRECTLY contains at least one `*.md`
 * file, returned by its full relative name using `/` separators - so
 * both a flat bundle (`lore/foo/*.md` -> `foo`) and a nested/grouped one
 * (`lore/home/foo/*.md` -> `home/foo`) are found to arbitrary depth. A
 * pure grouping dir that holds only subdirectories and no `*.md` of its
 * own (e.g. `lore/home/`) is NOT a bundle and is not listed, though its
 * children still are.
 *
 * Index-only inventory: this enumerates the COMPLETE set of bundles
 * regardless of the active selection, and does NOT affect runtime
 * loading (that stays gated on `scanCast`'s `options.loreBundles`, whose
 * slashed tokens resolve through {@link loreBundleDir}). Top-level
 * `lore/*.md` are base lore, never a bundle, so the scan starts one
 * level down.
 */
export function listLoreBundles(cast: string, root: string = roleplayRoot()): string[] {
  const loreRoot = kindDir(cast, 'lore', root);
  const out: string[] = [];

  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    let hasMd = false;
    const subdirs: string[] = [];
    for (const name of names) {
      let stat;
      try {
        stat = statSync(join(dir, name));
      } catch {
        continue;
      }
      if (stat.isDirectory()) subdirs.push(name);
      else if (stat.isFile() && name.endsWith('.md')) hasMd = true;
    }
    // rel === '' is the lore root itself: its `*.md` are base lore, not a bundle.
    if (rel !== '' && hasMd) out.push(rel);
    for (const sub of subdirs) walk(join(dir, sub), rel === '' ? sub : `${rel}/${sub}`);
  };

  walk(loreRoot, '');
  return out.sort();
}

/**
 * Walk `<castDir>/<kind>/*.md` for each known kind and parse frontmatter
 * into `RoleplayEntry` records. Malformed files are skipped with a
 * warning so one bad file doesn't blind the whole cast.
 *
 * When `options.loreBundles` is non-empty, each named bundle subfolder
 * (`lore/<name>/*.md`) is scanned on top of the base lore with
 * bundle-overrides-base precedence (see the bundle note above). An
 * activated name with no matching subfolder is reported as a warning.
 */
export function scanCast(
  cast: string,
  root: string = roleplayRoot(),
  options: ScanCastOptions = {},
): { entries: RoleplayEntry[]; warnings: string[] } {
  const byKey = new Map<string, RoleplayEntry>();
  const warnings: ScanWarning[] = [];
  const base = castDir(cast, root);

  for (const kind of ROLEPLAY_KINDS) {
    for (const e of readKindDir(join(base, kind), kind, warnings)) byKey.set(`${kind}/${e.id}`, e);
  }

  for (const bundle of options.loreBundles ?? []) {
    const dir = loreBundleDir(cast, bundle, root);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      warnings.push({ path: dir, reason: `lore bundle "${bundle}" not found` });
      continue;
    }
    for (const e of readKindDir(dir, 'lore', warnings, bundle)) byKey.set(`lore/${e.id}`, e);
  }

  const entries = [...byKey.values()].sort((a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`));

  return { entries, warnings: warnings.map((w) => `${w.path}: ${w.reason}`) };
}

/**
 * Build a COMPLETE, index-only view of a cast: the base records for every
 * kind PLUS every lore bundle present on disk (`listLoreBundles`), NOT
 * just the active selection. Unlike {@link scanCast} there is no
 * cross-tier dedup - a base `lore/setting.md` and a bundle
 * `lore/loft/setting.md` sharing an id BOTH appear, each carrying its own
 * `bundle` annotation - so the rendered `INDEX.md` is a stable, complete
 * map of the cast independent of whatever bundles happened to be active.
 * This never feeds runtime state; use `scanCast` for that.
 */
export function scanCastComplete(
  cast: string,
  root: string = roleplayRoot(),
): { entries: RoleplayEntry[]; warnings: string[] } {
  const entries: RoleplayEntry[] = [];
  const warnings: ScanWarning[] = [];
  const base = castDir(cast, root);

  for (const kind of ROLEPLAY_KINDS) {
    entries.push(...readKindDir(join(base, kind), kind, warnings));
  }
  for (const bundle of listLoreBundles(cast, root)) {
    entries.push(...readKindDir(loreBundleDir(cast, bundle, root), 'lore', warnings, bundle));
  }

  entries.sort((a, b) => {
    const byKind = ROLEPLAY_KINDS.indexOf(a.kind) - ROLEPLAY_KINDS.indexOf(b.kind);
    if (byKind !== 0) return byKind;
    // Base ('' bundle) sorts before any named bundle, then by id.
    const byBundle = (a.bundle ?? '').localeCompare(b.bundle ?? '');
    if (byBundle !== 0) return byBundle;
    return a.id.localeCompare(b.id);
  });

  return { entries, warnings: warnings.map((w) => `${w.path}: ${w.reason}`) };
}

/** Rebuild the in-memory state for a cast from disk. */
export function rebuildCast(
  cast: string,
  root: string = roleplayRoot(),
  options: ScanCastOptions = {},
): { state: RoleplayState; warnings: string[] } {
  const { entries, warnings } = scanCast(cast, root, options);
  return { state: { cast, entries }, warnings };
}

/**
 * (Re)write a cast's `INDEX.md`. The index is a human/agent-facing map
 * only (never read at runtime), so it always reflects the COMPLETE
 * on-disk inventory - base lore plus every bundle - via
 * {@link scanCastComplete}, independent of which bundles are active in
 * `state`. Only `state.cast` is consumed.
 */
export function writeIndex(state: RoleplayState, root: string = roleplayRoot()): void {
  const { entries } = scanCastComplete(state.cast, root);
  atomicWriteFile(indexFileFor(state.cast, root), renderIndexMd({ cast: state.cast, entries }));
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
