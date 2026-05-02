/**
 * On-disk storage for the iteration-loop extension.
 *
 * Layout (rooted at `<cwd>/.pi/checks/`):
 *
 *   <task>.draft.json          proposed but not accepted
 *   <task>.json                accepted active check spec
 *   <task>.snapshots/
 *     iter-001.<ext>           artifact snapshot per iteration
 *     iter-001.verdict.json    verdict for that iteration
 *     ...
 *   archive/
 *     <ts>-<task>/             whole task dir moved here on close
 *
 * State (iteration count, history, best-so-far) is NOT here — it
 * lives in the session branch via `iteration-loop-reducer.ts`. The
 * disk layout is only for things that cross sessions: the check spec
 * itself (user accepts → should survive a pi restart) and the
 * artifact snapshots (binary data we don't want in session entries).
 *
 * All writes are atomic via tmp-file + rename, matching the
 * `atomicWriteFile` pattern in `memory-paths.ts`. Reads tolerate
 * missing files (return null) so the extension never crashes on a
 * freshly initialized workspace.
 *
 * No pi imports — testable under `vitest` with a temp cwd.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';

import { atomicWriteFile, ensureDirSync } from './atomic-write.ts';
import { type CheckSpec, isCheckSpecShape, type Verdict } from './iteration-loop-schema.ts';

// `atomicWriteFile` + `ensureDirSync` are re-exported so callers inside
// this module (and consumers of the storage module) get them through
// the usual entry point. The canonical implementation lives in
// atomic-write.ts so memory-paths.ts + any future consumer share a
// single policy (unique tempfile suffix, parent mkdir, no fsync).
export { atomicWriteFile, ensureDirSync };

/** Directory under cwd where all iteration-loop on-disk state lives. */
export const CHECKS_DIR = '.pi/checks';

// ──────────────────────────────────────────────────────────────────────
// Path helpers
// ──────────────────────────────────────────────────────────────────────

export function checksDir(cwd: string): string {
  return join(cwd, CHECKS_DIR);
}

export function draftPath(cwd: string, task: string): string {
  return join(checksDir(cwd), `${task}.draft.json`);
}

export function activePath(cwd: string, task: string): string {
  return join(checksDir(cwd), `${task}.json`);
}

export function snapshotsDir(cwd: string, task: string): string {
  return join(checksDir(cwd), `${task}.snapshots`);
}

export function archiveDir(cwd: string): string {
  return join(checksDir(cwd), 'archive');
}

export function snapshotPath(cwd: string, task: string, iteration: number, artifactPath: string): string {
  const ext = extname(artifactPath); // includes leading '.' or ''
  const padded = iteration.toString().padStart(3, '0');
  return join(snapshotsDir(cwd, task), `iter-${padded}${ext}`);
}

export function snapshotVerdictPath(cwd: string, task: string, iteration: number): string {
  const padded = iteration.toString().padStart(3, '0');
  return join(snapshotsDir(cwd, task), `iter-${padded}.verdict.json`);
}

function safeReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Spec I/O — draft, active, accept, close
// ──────────────────────────────────────────────────────────────────────

export interface ReadSpecResult {
  state: 'none' | 'draft' | 'active';
  spec: CheckSpec | null;
  /**
   * Populated when the draft or active file existed but failed to
   * parse / validate. Caller decides whether to surface or swallow.
   */
  error: string | null;
}

function parseSpecFile(path: string, state: 'draft' | 'active'): ReadSpecResult {
  const raw = safeReadText(path);
  if (raw === null) return { state, spec: null, error: `failed to read ${path}` };
  const parsed = safeParseJson(raw);
  if (parsed === null) return { state, spec: null, error: `${path} is not valid JSON` };
  if (!isCheckSpecShape(parsed)) {
    return { state, spec: null, error: `${path} does not match CheckSpec shape` };
  }
  return { state, spec: parsed, error: null };
}

/**
 * Read the current spec for `task`, preferring the accepted active
 * file over a pending draft. Returns `{ state: 'none' }` when neither
 * file exists.
 */
export function readSpec(cwd: string, task: string): ReadSpecResult {
  const active = activePath(cwd, task);
  if (existsSync(active)) {
    return parseSpecFile(active, 'active');
  }
  const draft = draftPath(cwd, task);
  if (existsSync(draft)) {
    return parseSpecFile(draft, 'draft');
  }
  return { state: 'none', spec: null, error: null };
}

/**
 * Write a draft spec. Overwrites any prior draft for the same task.
 * Fails if an accepted spec already exists — declaring a new draft
 * while a task is live is a user error.
 */
export function writeDraft(cwd: string, spec: CheckSpec): { ok: true } | { ok: false; error: string } {
  if (existsSync(activePath(cwd, spec.task))) {
    return {
      ok: false,
      error: `task "${spec.task}" already has an accepted check at ${activePath(cwd, spec.task)} — close it before declaring a new draft`,
    };
  }
  atomicWriteFile(draftPath(cwd, spec.task), JSON.stringify(spec, null, 2));
  return { ok: true };
}

/**
 * Promote the draft to active by writing `<task>.json` atomically
 * (with `acceptedAt` set) and removing the `.draft.json` file.
 *
 * Refuses when no draft exists, when an active file already exists,
 * or when the draft is malformed.
 */
export function acceptDraft(
  cwd: string,
  task: string,
  acceptedAt: string,
): { ok: true; spec: CheckSpec } | { ok: false; error: string } {
  const active = activePath(cwd, task);
  // TOCTOU note: two `acceptDraft` calls for the same task racing
  // between this `existsSync` and the `atomicWriteFile` below will
  // both see no active file and both write. `atomicWriteFile`'s
  // rename is atomic so the file is never half-written, but the
  // last writer wins and overwrites the first acceptance's
  // acceptedAt timestamp. That's acceptable here — acceptance is a
  // user-gated action in practice, and the spec content itself is
  // identical across racers (both came from the same draft).
  if (existsSync(active)) {
    return { ok: false, error: `task "${task}" is already accepted` };
  }
  const draft = draftPath(cwd, task);
  if (!existsSync(draft)) {
    return { ok: false, error: `no draft found for task "${task}"` };
  }
  const parsed = parseSpecFile(draft, 'draft');
  if (!parsed.spec) {
    return { ok: false, error: parsed.error ?? `failed to load draft for "${task}"` };
  }
  const accepted: CheckSpec = { ...parsed.spec, acceptedAt };
  atomicWriteFile(active, JSON.stringify(accepted, null, 2));
  try {
    unlinkSync(draft);
  } catch {
    // Best-effort: the active file is authoritative. A leftover draft
    // will be ignored by readSpec() since active takes precedence.
  }
  return { ok: true, spec: accepted };
}

/**
 * Remove the draft for `task` (no-op when absent). Used by `check
 * close` on a task that was never accepted.
 */
export function discardDraft(cwd: string, task: string): void {
  const p = draftPath(cwd, task);
  if (existsSync(p)) unlinkSync(p);
}

/** Separator between the ISO timestamp and the task name in an archive dir name. */
const ARCHIVE_SEPARATOR = '__';

/**
 * `renameSync` fails with EXDEV when source and dest are on different
 * filesystems (e.g. bind mounts in CI). Fall back to recursive copy +
 * remove so archive still works; any other error re-throws.
 */
function renameOrFallback(src: string, dest: string): void {
  try {
    renameSync(src, dest);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
  }
  // Cross-device: cpSync is idempotent enough for our purposes, then rm.
  cpSync(src, dest, { recursive: true });
  rmSync(src, { recursive: true, force: true });
}

/**
 * Move the whole task directory (active spec + snapshots) under
 * `archive/<timestamp>__<task>/`. Used by `check close` on a
 * successful or exhausted loop.
 *
 * Returns the archive directory path. Missing tasks are a no-op
 * (returns null) so the caller can close defensively.
 */
export function archiveTask(cwd: string, task: string, timestamp: string): string | null {
  const active = activePath(cwd, task);
  const snaps = snapshotsDir(cwd, task);
  const hasActive = existsSync(active);
  const hasSnaps = existsSync(snaps);
  if (!hasActive && !hasSnaps) return null;
  // Archive dirs use `<safeTs>__<task>` — a double-underscore separator
  // so hyphens in either timestamps (always) or task names (user-chosen)
  // round-trip cleanly through `listArchive`'s parser. `safeTs` strips
  // anything that isn't a safe filename char; `task` is re-normalized
  // the same way so a pathological task slug can't escape the archive
  // directory or collide with the separator.
  const safeTs = timestamp.replace(/[^0-9A-Za-z_.-]/g, '-');
  const safeTask = task.replace(/[^0-9A-Za-z_.-]/g, '-');
  let destDir = join(archiveDir(cwd), `${safeTs}${ARCHIVE_SEPARATOR}${safeTask}`);
  // Two `close` calls landing in the same wall-clock second (possible
  // under scripted / test workloads) would otherwise `renameSync` into
  // an existing destDir. Append a short disambiguator until free.
  if (existsSync(destDir)) {
    for (let i = 2; i < 100; i++) {
      const candidate = `${destDir}.${i}`;
      if (!existsSync(candidate)) {
        destDir = candidate;
        break;
      }
    }
  }
  ensureDirSync(destDir);
  if (hasActive) {
    renameOrFallback(active, join(destDir, basename(active)));
  }
  if (hasSnaps) {
    renameOrFallback(snaps, join(destDir, basename(snaps)));
  }
  // Clean up any lingering draft alongside
  discardDraft(cwd, task);
  return destDir;
}

// ──────────────────────────────────────────────────────────────────────
// Snapshot I/O
// ──────────────────────────────────────────────────────────────────────

/**
 * Copy the artifact file into the snapshots directory under a
 * deterministic `iter-NNN` name and return:
 *   - the snapshot path
 *   - the sha256 hash of the bytes (hex), used for fixpoint detection
 *
 * Returns null when the artifact doesn't exist — caller decides
 * whether that's an error (check run before first edit) or expected.
 */
export function snapshotArtifact(
  cwd: string,
  task: string,
  iteration: number,
  artifactPath: string,
): { path: string; hash: string } | null {
  // Respect absolute artifact paths — otherwise `join(cwd, '/abs/path')` on
  // POSIX produces `/cwd/abs/path` which never exists. Only prepend cwd for
  // relative artifacts.
  const src = isAbsolute(artifactPath) ? artifactPath : join(cwd, artifactPath);
  if (!existsSync(src)) return null;
  ensureDirSync(snapshotsDir(cwd, task));
  const dest = snapshotPath(cwd, task, iteration, artifactPath);
  copyFileSync(src, dest);
  const bytes = readFileSync(dest);
  const hash = createHash('sha256').update(bytes).digest('hex');
  return { path: dest, hash };
}

/**
 * Write the verdict JSON alongside its iteration snapshot. Returns
 * the path written.
 */
export function writeSnapshotVerdict(cwd: string, task: string, iteration: number, verdict: Verdict): string {
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error(`writeSnapshotVerdict: iteration must be an integer ≥ 1, got ${iteration}`);
  }
  const p = snapshotVerdictPath(cwd, task, iteration);
  atomicWriteFile(p, JSON.stringify(verdict, null, 2));
  return p;
}

// ──────────────────────────────────────────────────────────────────────
// Listing
// ──────────────────────────────────────────────────────────────────────

export interface TaskListing {
  task: string;
  state: 'draft' | 'active';
  path: string;
}

/**
 * List every active + draft task under `.pi/checks/`. Does NOT walk
 * the archive dir — use `listArchive` for that.
 */
export function listTasks(cwd: string): TaskListing[] {
  const dir = checksDir(cwd);
  if (!existsSync(dir)) return [];
  const out: TaskListing[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;
    if (name.endsWith('.draft.json')) {
      out.push({ task: name.slice(0, -'.draft.json'.length), state: 'draft', path: full });
    } else if (name.endsWith('.json')) {
      out.push({ task: name.slice(0, -'.json'.length), state: 'active', path: full });
    }
  }
  // Dedupe — an active spec supersedes a draft with the same name
  const byTask = new Map<string, TaskListing>();
  for (const t of out) {
    const prev = byTask.get(t.task);
    if (!prev || (prev.state === 'draft' && t.state === 'active')) {
      byTask.set(t.task, t);
    }
  }
  return [...byTask.values()].sort((a, b) => a.task.localeCompare(b.task));
}

export interface ArchiveListing {
  dir: string;
  timestamp: string;
  task: string;
}

/** List entries under `<cwd>/.pi/checks/archive/`. */
export function listArchive(cwd: string): ArchiveListing[] {
  const dir = archiveDir(cwd);
  if (!existsSync(dir)) return [];
  const out: ArchiveListing[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    // `<ts>__<task>` — split on the LAST occurrence of the separator
    // so pathologically odd (sanitized) task names still round-trip.
    // Fall back to legacy single-dash split for archives written before
    // the separator change so existing trees stay listable.
    const sepIdx = name.lastIndexOf(ARCHIVE_SEPARATOR);
    if (sepIdx >= 0) {
      out.push({
        dir: full,
        timestamp: name.slice(0, sepIdx),
        task: name.slice(sepIdx + ARCHIVE_SEPARATOR.length),
      });
      continue;
    }
    const legacyIdx = name.lastIndexOf('-');
    if (legacyIdx < 0) {
      out.push({ dir: full, timestamp: '', task: name });
    } else {
      out.push({ dir: full, timestamp: name.slice(0, legacyIdx), task: name.slice(legacyIdx + 1) });
    }
  }
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
