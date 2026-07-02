/**
 * Filesystem layout + disk I/O helpers for the memory extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * The memory tree mirrors pi's own session layout - same cwd-slug scheme
 * under `<root>/projects/<cwd-slug>/` as pi uses for
 * `~/.pi/agent/sessions/<cwd-slug>/`. That way the project dir for a given
 * workspace lines up one-to-one with its session directory.
 *
 *   <root>/
 *     global/
 *       MEMORY.md
 *       user/<slug>.md
 *       feedback/<slug>.md
 *     projects/<cwd-slug>/
 *       MEMORY.md
 *       user/<slug>.md
 *       feedback/<slug>.md
 *       project/<slug>.md
 *       reference/<slug>.md
 *       sessions/<session-id>/
 *         MEMORY.md
 *         note/<slug>.md
 *
 * The `sessions/<session-id>/` subtree holds session-scoped `note`
 * memory keyed the same way pi names its `<sid>.jsonl` transcript; it is
 * only loaded for the session that owns it.
 *
 * `<root>` defaults to `~/.pi/agent/memory`, overridable via
 * `PI_MEMORY_ROOT`.
 *
 * The `projects/<cwd-slug>` segment is normally derived from the cwd, but
 * `PI_MEMORY_PROJECT_SLUG` pins it to a fixed, cwd-independent slug. That
 * makes the project subtree survive a workspace folder rename/move (the
 * cwd slug would otherwise be recomputed from the new absolute path and
 * orphan the old files). When unset, behaviour is unchanged.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile, ensureDirSync } from './atomic-write.ts';
import { parseFrontmatter, takenSlugs, validTypesForScope } from './memory-reducer.ts';
import { cwdSlug, piAgentPath, slugFromEnv } from './pi-paths.ts';
import {
  type Frontmatter,
  type MemoryEntry,
  type MemoryScope,
  type MemoryState,
  type MemoryType,
} from './memory-reducer.ts';

// `ensureDirSync` + `atomicWriteFile` are re-exported so memory-paths
// consumers continue to import from this module; the canonical
// implementation lives in atomic-write.ts so iteration-loop-storage.ts
// + any future consumer share a single policy.
export { atomicWriteFile, ensureDirSync };

// `cwdSlug` is a generic pi-layout helper - its canonical home is
// `pi-paths.ts`. Re-exported here only for the memory module's own
// consumers; new callers should import it from `pi-paths.ts` directly.
export { cwdSlug };

/**
 * Filesystem-safe slug for a memory *name*. Lowercases, replaces
 * non-alphanumerics with `-`, and collapses/trims dashes. Returns
 * `memory` if the input has no usable characters (e.g. all whitespace
 * or punctuation), so callers always get a non-empty slug.
 */
export function slugifyName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : 'memory';
}

/**
 * Pick a slug that doesn't collide with any existing entry id. Appends
 * `-2`, `-3`, … as needed.
 */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological fallback - shouldn't happen in practice.
  return `${base}-${Date.now()}`;
}

/**
 * Pick a slug for a new or renamed memory inside `scope`.
 * `excludeId` lets rename-in-place keep the outgoing entry's own slug.
 */
export function chooseMemorySlug(state: MemoryState, scope: MemoryScope, name: string, excludeId?: string): string {
  const base = slugifyName(name);
  const taken = takenSlugs(state.index, scope);
  if (excludeId !== undefined) taken.delete(excludeId);
  return uniqueSlug(base, taken);
}

/** Absolute path to the memory root, honouring `PI_MEMORY_ROOT` (and
 * `PI_CODING_AGENT_DIR` for the default via `piAgentPath`). */
export function memoryRoot(): string {
  const env = process.env.PI_MEMORY_ROOT;
  if (env && env.trim().length > 0) return env.trim();
  return piAgentPath('memory');
}

export function globalDir(root: string = memoryRoot()): string {
  return join(root, 'global');
}

/**
 * The slug used for the `projects/<slug>` memory subtree. Honours
 * `PI_MEMORY_PROJECT_SLUG` (trimmed, when non-empty) as a fixed,
 * cwd-independent override so the project subtree survives a workspace
 * rename/move; otherwise falls back to the cwd-derived slug. Pure - reads
 * only `process.env` and the given cwd.
 */
export function projectSlug(cwd: string): string {
  return slugFromEnv(process.env.PI_MEMORY_PROJECT_SLUG, cwd);
}

export function projectDir(cwd: string, root: string = memoryRoot()): string {
  return join(root, 'projects', projectSlug(cwd));
}

/** Parent dir holding every session's memory subtree for a workspace. */
export function sessionsParentDir(cwd: string, root: string = memoryRoot()): string {
  return join(projectDir(cwd, root), 'sessions');
}

/**
 * Directory holding the session-scoped memory for a given session id,
 * keyed the same way pi names its `<sid>.jsonl` transcript. Lives under
 * the project dir so a workspace's sessions sit next to its durable
 * project memory.
 */
export function sessionDir(cwd: string, sessionId: string, root: string = memoryRoot()): string {
  return join(sessionsParentDir(cwd, root), sessionId);
}

/**
 * Base directory for a scope. `session` requires a `sessionId` - callers
 * resolving a session path without one have a bug, so we throw rather
 * than silently writing to the project dir.
 */
function scopeBaseDir(scope: MemoryScope, cwd: string, sessionId: string | null, root: string): string {
  if (scope === 'global') return globalDir(root);
  if (scope === 'session') {
    if (!sessionId) throw new Error('memory: session scope requires a sessionId');
    return sessionDir(cwd, sessionId, root);
  }
  return projectDir(cwd, root);
}

/** Directory holding memories of `type` for a given scope. */
export function typeDir(
  scope: MemoryScope,
  type: MemoryType,
  cwd: string,
  sessionId: string | null = null,
  root: string = memoryRoot(),
): string {
  return join(scopeBaseDir(scope, cwd, sessionId, root), type);
}

export function fileFor(
  scope: MemoryScope,
  type: MemoryType,
  slug: string,
  cwd: string,
  sessionId: string | null = null,
  root: string = memoryRoot(),
): string {
  return join(typeDir(scope, type, cwd, sessionId, root), `${slug}.md`);
}

export function indexFileFor(
  scope: MemoryScope,
  cwd: string,
  sessionId: string | null = null,
  root: string = memoryRoot(),
): string {
  return join(scopeBaseDir(scope, cwd, sessionId, root), 'MEMORY.md');
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

export function readMemoryBody(entry: MemoryEntry, cwd: string, sessionId: string | null = null): string | null {
  const path = fileFor(entry.scope, entry.type, entry.id, cwd, sessionId);
  if (!existsSync(path)) return null;
  const raw = readTextFile(path);
  if (raw == null) return null;
  const parsed = parseFrontmatter(raw);
  return parsed ? parsed.body : raw;
}

/**
 * Read the parsed frontmatter for an entry's on-disk file, or `null` when
 * the file is missing / unreadable / lacks valid frontmatter. Used by
 * `update` to carry the original `created` timestamp forward.
 */
export function readMemoryFrontmatter(
  entry: MemoryEntry,
  cwd: string,
  sessionId: string | null = null,
): Frontmatter | null {
  const path = fileFor(entry.scope, entry.type, entry.id, cwd, sessionId);
  if (!existsSync(path)) return null;
  const raw = readTextFile(path);
  if (raw == null) return null;
  const parsed = parseFrontmatter(raw);
  return parsed ? parsed.frontmatter : null;
}

export interface ScanWarning {
  path: string;
  reason: string;
}

/**
 * Walk `<scopeDir>/<type>/*.md` for each known memory type and parse
 * frontmatter into `MemoryEntry` records. Malformed files are skipped
 * with a warning so a single bad file doesn't blind the whole index.
 */
export function scanScope(
  scopeDir: string,
  scope: MemoryScope,
  warnings: ScanWarning[] = [],
): { entries: MemoryEntry[]; warnings: ScanWarning[] } {
  const entries: MemoryEntry[] = [];
  const validTypes: MemoryType[] = validTypesForScope(scope);

  for (const type of validTypes) {
    const dir = join(scopeDir, type);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue; // directory absent - fine.
    }
    for (const name of files) {
      if (!name.endsWith('.md')) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
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
      if (parsed.frontmatter.type !== type) {
        warnings.push({ path: full, reason: `frontmatter type "${parsed.frontmatter.type}" != directory "${type}"` });
        continue;
      }
      const slug = name.slice(0, -3);
      entries.push({
        id: slug,
        scope,
        type,
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        // Absent / unparseable timestamps were normalised to `undefined`
        // by `parseFrontmatter`; carry them straight through.
        created: parsed.frontmatter.created,
        updated: parsed.frontmatter.updated,
      });
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.id.localeCompare(b.id);
  });

  return { entries, warnings };
}

export function rebuildMemoryIndex(
  cwd: string,
  sessionId: string | null = null,
): { state: MemoryState; warnings: string[] } {
  const warnings: string[] = [];
  const g = scanScope(globalDir(), 'global');
  const p = scanScope(projectDir(cwd), 'project');
  // Only the current session's dir is scanned - other sessions' notes are
  // never loaded, so session memory stays scoped to the session that owns it.
  const s = sessionId ? scanScope(sessionDir(cwd, sessionId), 'session') : { entries: [], warnings: [] };
  for (const w of [...g.warnings, ...p.warnings, ...s.warnings]) warnings.push(`${w.path}: ${w.reason}`);
  return {
    state: {
      index: { global: g.entries, project: p.entries, session: s.entries },
      projectSlug: projectSlug(cwd),
      sessionId,
    },
    warnings,
  };
}

/**
 * List the session ids that currently have a memory subtree under a
 * workspace (`<projectDir>/sessions/<id>/`). Returns directory names
 * only; missing parent dir yields an empty list.
 */
export function listSessionMemoryDirs(cwd: string, root: string = memoryRoot()): string[] {
  const parent = sessionsParentDir(cwd, root);
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  return names.filter((name) => {
    try {
      return statSync(join(parent, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Delete session memory dirs whose id is not in `liveSessionIds` (i.e.
 * sessions with no surviving transcript). Returns the ids that were
 * pruned. The caller supplies the live set so this stays pure-ish and
 * testable without reaching into pi's session store.
 */
export function pruneOrphanSessionDirs(
  cwd: string,
  liveSessionIds: Iterable<string>,
  root: string = memoryRoot(),
): string[] {
  const live = liveSessionIds instanceof Set ? liveSessionIds : new Set(liveSessionIds);
  const parent = sessionsParentDir(cwd, root);
  const removed: string[] = [];
  for (const id of listSessionMemoryDirs(cwd, root)) {
    if (live.has(id)) continue;
    rmSync(join(parent, id), { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}
