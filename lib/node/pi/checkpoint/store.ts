/**
 * Content-addressed blob store + per-entry manifest index for the
 * `checkpoint` extension, stored project-scoped under the pi agent dir:
 *
 *   <agentDir>/checkpoints/<projectKey>/
 *     blobs/<sha256>      # deduped before- AND after-content blobs
 *     <entryId>.json      # one manifest per user message
 *
 * The `<agentDir>/checkpoints` root is overridable via
 * `PI_CHECKPOINT_STORE_ROOT`, and `<projectKey>` (normally a hash of the
 * git-toplevel / cwd, so a rename orphans it) is overridable via
 * `PI_CHECKPOINT_PROJECT_KEY` to pin it to a fixed, cwd-independent value.
 * Both default to today's behaviour when unset.
 *
 * Blobs are written once (the path IS the hash, so a re-put is a cheap
 * stat) which makes the `after` snapshots nearly free - `after[N]` is
 * usually byte-identical to `before[N+1]`. Manifests are keyed by the
 * session-tree entry id they anchor to, so they survive a fork's new
 * session file (fork preserves entry ids).
 *
 * I/O only via `node:fs` + `node:crypto` - no pi imports - so the store
 * is exercisable under vitest against a temp dir.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { atomicWriteFile } from '../atomic-write.ts';
import { piAgentPath } from '../pi-paths.ts';

import type { CheckpointManifest } from './types.ts';

/** sha256 hex of `bytes`. The content-address used for every blob. */
export function hashBytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A short, stable, collision-resistant key for `absPath` (the git toplevel
 * when in a repo, else the realpath'd cwd). `<basename>-<sha1[:12]>` keeps
 * the directory human-recognizable while the hash of the FULL path
 * disambiguates two projects that share a basename. The shell resolves
 * `absPath`; this stays pure so it's testable. `PI_CHECKPOINT_PROJECT_KEY`
 * pins the key to a fixed, cwd-independent value (path-sanitized) so the
 * store survives a workspace rename/move; unset = the hashed default.
 */
export function deriveProjectKey(absPath: string): string {
  const override = process.env.PI_CHECKPOINT_PROJECT_KEY?.trim();
  if (override) return override.replace(/[^A-Za-z0-9._-]/g, '_');
  const hash = createHash('sha1').update(absPath).digest('hex').slice(0, 12);
  const name = basename(absPath) || 'root';
  // Strip anything that isn't path-safe so the dir name can't surprise us.
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe}-${hash}`;
}

/**
 * Absolute path to the checkpoint store root. Honours
 * `PI_CHECKPOINT_STORE_ROOT`; falls back to `<agentDir>/checkpoints`.
 */
export function checkpointStoreRoot(): string {
  const env = process.env.PI_CHECKPOINT_STORE_ROOT;
  if (env && env.trim().length > 0) return env.trim();
  return piAgentPath('checkpoints');
}

/** Absolute path to the store dir for `projectKey` under the store root. */
export function checkpointStoreDir(projectKey: string): string {
  return join(checkpointStoreRoot(), projectKey);
}

function blobPath(storeDir: string, sha: string): string {
  return join(storeDir, 'blobs', sha);
}

function manifestPath(storeDir: string, entryId: string): string {
  return join(storeDir, `${entryId}.json`);
}

/** True if a blob with this hash is already on disk. */
export function hasBlob(storeDir: string, sha: string): boolean {
  return existsSync(blobPath(storeDir, sha));
}

/**
 * Store `bytes` and return its sha256 hash. Write-once: if the blob already
 * exists (same hash ⇒ same content) the write is skipped, so dedup is free.
 */
export function putBlob(storeDir: string, bytes: Buffer | string): string {
  const sha = hashBytes(bytes);
  const path = blobPath(storeDir, sha);
  if (!existsSync(path)) atomicWriteFile(path, bytes);
  return sha;
}

/** Read a blob's bytes, or `undefined` if missing / unreadable. */
export function getBlob(storeDir: string, sha: string): Buffer | undefined {
  try {
    return readFileSync(blobPath(storeDir, sha));
  } catch {
    return undefined;
  }
}

/** Read a blob as UTF-8 text, or `undefined` if missing / unreadable. */
export function getBlobText(storeDir: string, sha: string): string | undefined {
  const buf = getBlob(storeDir, sha);
  return buf === undefined ? undefined : buf.toString('utf8');
}

/** Persist a manifest as `<leafEntryId>.json` (atomic). */
export function writeManifest(storeDir: string, manifest: CheckpointManifest): void {
  atomicWriteFile(manifestPath(storeDir, manifest.leafEntryId), `${JSON.stringify(manifest, null, 2)}\n`);
}

function isManifest(value: unknown): value is CheckpointManifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.leafEntryId === 'string' && typeof m.timestamp === 'number' && Array.isArray(m.entries);
}

/** Read the manifest anchored to `entryId`, or `undefined` if absent / malformed. */
export function readManifest(storeDir: string, entryId: string): CheckpointManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(storeDir, entryId), 'utf8')) as unknown;
    return isManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rebuild the manifest index from disk: every `<entryId>.json` under the
 * store dir, malformed ones skipped. Used on `session_start` to resume.
 * Returns an empty list when the store dir does not exist yet.
 */
export function listManifests(storeDir: string): CheckpointManifest[] {
  let names: string[];
  try {
    names = readdirSync(storeDir);
  } catch {
    return [];
  }
  const out: CheckpointManifest[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const m = readManifest(storeDir, name.slice(0, -'.json'.length));
    if (m !== undefined) out.push(m);
  }
  return out;
}

export interface PruneResult {
  /** entry ids of manifests removed for being older than the cutoff. */
  prunedManifests: string[];
  /** sha256 hashes of blobs garbage-collected (no surviving manifest refs). */
  prunedBlobs: string[];
}

/** Every blob hash referenced (before or after) by `manifests`. */
function referencedBlobs(manifests: CheckpointManifest[]): Set<string> {
  const refs = new Set<string>();
  for (const m of manifests) {
    for (const e of m.entries) {
      if (e.before !== null) refs.add(e.before);
      if (e.after !== null) refs.add(e.after);
    }
  }
  return refs;
}

/**
 * Prune manifests with `timestamp` older than `retentionDays` before `now`,
 * then garbage-collect any blob no surviving manifest still references
 * (mark-sweep). `retentionDays === 0` means keep forever (no-op). Pure of
 * pi; safe to call on a missing store dir.
 */
export function pruneOldManifests(storeDir: string, retentionDays: number, now: number = Date.now()): PruneResult {
  const result: PruneResult = { prunedManifests: [], prunedBlobs: [] };
  if (retentionDays <= 0) return result;

  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const all = listManifests(storeDir);
  const survivors: CheckpointManifest[] = [];

  for (const m of all) {
    if (m.timestamp < cutoff) {
      try {
        rmSync(manifestPath(storeDir, m.leafEntryId));
        result.prunedManifests.push(m.leafEntryId);
      } catch {
        survivors.push(m); // couldn't delete → keep it referenced
      }
    } else {
      survivors.push(m);
    }
  }

  if (result.prunedManifests.length === 0) return result;

  const keep = referencedBlobs(survivors);
  const blobsDir = join(storeDir, 'blobs');
  let blobNames: string[];
  try {
    blobNames = readdirSync(blobsDir);
  } catch {
    return result;
  }
  for (const sha of blobNames) {
    if (keep.has(sha)) continue;
    try {
      rmSync(join(blobsDir, sha));
      result.prunedBlobs.push(sha);
    } catch {
      // leave it; a stray blob is harmless and will be retried next prune.
    }
  }
  return result;
}

/**
 * Byte size of the file at `absPath`, or `undefined` if it does not exist /
 * is unreadable. Used by the shell's per-file cap check before snapshotting.
 */
export function fileSize(absPath: string): number | undefined {
  try {
    return statSync(absPath).size;
  } catch {
    return undefined;
  }
}
