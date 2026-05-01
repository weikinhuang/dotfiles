/**
 * Filesystem layout + disk I/O helpers for the memory extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * The memory tree mirrors pi's own session layout — same cwd-slug scheme
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
 *
 * `<root>` defaults to `~/.pi/agent/memory`, overridable via
 * `PI_MEMORY_ROOT`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseFrontmatter } from './memory-reducer.ts';
import { type MemoryEntry, type MemoryScope, type MemoryType } from './memory-reducer.ts';

/**
 * Transform a cwd into the directory name pi uses for its session store:
 * replace `/` with `-` and wrap in `--…--`. So `/mnt/d/foo` becomes
 * `--mnt-d-foo--`. Pure — no subprocess, no git lookup.
 *
 * The leading/trailing double-dash is pi's own visual marker that this is
 * a full-path-encoded directory rather than a normal name.
 */
export function cwdSlug(cwd: string): string {
  const stripped = cwd.replace(/^\/+|\/+$/g, '');
  return `--${stripped.split('/').join('-')}--`;
}

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
  // Pathological fallback — shouldn't happen in practice.
  return `${base}-${Date.now()}`;
}

/** Absolute path to the memory root, honouring `PI_MEMORY_ROOT`. */
export function memoryRoot(): string {
  const env = process.env.PI_MEMORY_ROOT;
  if (env && env.trim().length > 0) return env.trim();
  return join(homedir(), '.pi', 'agent', 'memory');
}

export function globalDir(root: string = memoryRoot()): string {
  return join(root, 'global');
}

export function projectDir(cwd: string, root: string = memoryRoot()): string {
  return join(root, 'projects', cwdSlug(cwd));
}

/** Directory holding memories of `type` for a given scope. */
export function typeDir(scope: MemoryScope, type: MemoryType, cwd: string, root: string = memoryRoot()): string {
  const base = scope === 'global' ? globalDir(root) : projectDir(cwd, root);
  return join(base, type);
}

export function fileFor(
  scope: MemoryScope,
  type: MemoryType,
  slug: string,
  cwd: string,
  root: string = memoryRoot(),
): string {
  return join(typeDir(scope, type, cwd, root), `${slug}.md`);
}

export function indexFileFor(scope: MemoryScope, cwd: string, root: string = memoryRoot()): string {
  const base = scope === 'global' ? globalDir(root) : projectDir(cwd, root);
  return join(base, 'MEMORY.md');
}

export function ensureDirSync(path: string): void {
  mkdirSync(path, { recursive: true });
}

/**
 * Write-then-rename so a partially-written file never stomps the previous
 * contents. `mkdir -p` the parent first so callers don't have to.
 */
export function atomicWriteFile(path: string, body: string): void {
  const tmp = `${path}.tmp`;
  const parent = dirname(path);
  // `dirname` returns `.` for a bare filename — still a valid dir to ensure.
  ensureDirSync(parent);
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
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
  const validTypes: MemoryType[] =
    scope === 'global' ? ['user', 'feedback'] : ['user', 'feedback', 'project', 'reference'];

  for (const type of validTypes) {
    const dir = join(scopeDir, type);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue; // directory absent — fine.
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
      });
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.id.localeCompare(b.id);
  });

  return { entries, warnings };
}
