/**
 * Quarantine + failure-counter helpers.
 *
 * When a research-toolkit artifact fails validation (malformed
 * typed-output exhausted retries, run.sh violated the lint policy,
 * metrics.json didn't match its schema, ...), we move it into a
 * sibling `_quarantined/` directory instead of deleting it. Two
 * reasons:
 *
 *   1. The robustness principle says failures are *visible*. A user
 *      inspecting the run tree can see that a finding was rejected
 *      and why, not just that it's missing.
 *   2. Quarantined artifacts are raw material for "why did this
 *      pipeline break?" debugging after the fact. Deletion loses
 *      signal.
 *
 * Quarantine is paired with a small on-disk failure counter so
 * callers can implement "twice-malformed → quarantine" policies
 * without stitching together their own JSON state. The counter is
 * deliberately minimal — bump / get / reset keyed by opaque id; the
 * meaning of "attempt" is the caller's.
 *
 * Atomic policy:
 *   - The artifact move is a single `renameSync` call. POSIX
 *     semantics: atomic on the same filesystem. If a crash
 *     interrupts `quarantine`, either the artifact is at its
 *     original path (and no sidecar reason exists) or it is at the
 *     target path (the reason file is then written immediately
 *     after, so in the worst case a reader sees a moved artifact
 *     with no reason.json until the subsequent write lands).
 *   - When a `<path>.provenance.json` sidecar exists it is moved
 *     by a second `renameSync` call. That rename is NOT atomic
 *     with the artifact's rename — a crash in between leaves the
 *     artifact moved and the sidecar stranded at the source path.
 *     The reader contract is tolerant (`readProvenance` returns
 *     `null` when no sidecar is found) so the partial state
 *     degrades gracefully.
 *   - All JSON writes (`reason.json`, the counter file) go through
 *     `atomic-write.atomicWriteFile`.
 *   - No EXDEV (cross-device) fallback. `renameSync` fails with
 *     EXDEV when source and destination are on different
 *     filesystems (rare: bind mounts, overlay FS). In a research
 *     run the quarantine target is always in the same tree as the
 *     source (`<parent>/_quarantined/...`), so EXDEV should not
 *     trigger. `iteration-loop-storage.ts` has a private
 *     `renameOrFallback` that copies-then-deletes as a fallback;
 *     if this module ever needs the same, extract that helper to
 *     `shared.ts` first.
 *
 * No pi imports.
 */

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { atomicWriteFile, ensureDirSync } from './atomic-write.ts';
import { quarantineDir } from './research-paths.ts';
import { sidecarPathFor } from './research-provenance.ts';
import { isRecord } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Types.
// ──────────────────────────────────────────────────────────────────────

export interface QuarantineOpts {
  /**
   * When true, do not mutate the filesystem. Compute the target
   * paths and return them. Useful for previewing what a quarantine
   * call would do without committing to it.
   */
  dryRun?: boolean;
  /**
   * Optional clock override. The default uses `new Date()`; tests
   * pass a frozen date so the generated target directory name is
   * deterministic.
   */
  now?: Date;
  /**
   * Optional caller tag copied into the reason sidecar. Surfaces in
   * post-run debugging: "which module quarantined this?"
   */
  caller?: string;
}

export interface QuarantineResult {
  /**
   * Absolute path the artifact now lives at (or would, if `dryRun`).
   * When the input was `a/b.md`, `movedTo` is
   * `a/_quarantined/b.md-<ts>/b.md`.
   */
  movedTo: string;
  /**
   * Absolute path of the `reason.json` sidecar alongside the moved
   * artifact. Written even when the quarantined input was a
   * directory; the reason file lives *next to* the moved artifact,
   * not inside it.
   */
  reasonFile: string;
}

/**
 * Shape persisted in `reason.json` inside each quarantine target
 * directory. Keep the schema narrow — `reason` is free-form so
 * callers can paste raw validation errors without reshaping them.
 */
export interface QuarantineReason {
  /** Relative display path of the original artifact. */
  originalPath: string;
  /** Caller-supplied explanation (validation error, lint message, ...). */
  reason: string;
  /** ISO8601 UTC. */
  ts: string;
  /** Optional caller tag, copied from `QuarantineOpts.caller`. */
  caller?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Quarantine primitive.
// ──────────────────────────────────────────────────────────────────────

/**
 * `YYYYMMDDTHHMMSSZ` — compact UTC stamp used as the quarantine
 * directory suffix. Same-second ties are broken by `firstAvailable`.
 */
function compactTimestamp(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');

  return (
    d.getUTCFullYear().toString().padStart(4, '0') +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * Given a desired path, return the path if it does not exist; else
 * append `-1`, `-2`, ... until an available path is found. Callers
 * use this to break the rare same-second quarantine collision.
 */
function firstAvailable(base: string): string {
  if (!existsSync(base)) return base;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existsSync(candidate)) return candidate;
  }

  // Pathological fallback: use a millisecond-precision suffix. The
  // chance of hitting this in practice is essentially zero.
  return `${base}-${Date.now()}`;
}

/**
 * Move `path` (and its `<path>.provenance.json` sidecar if present)
 * into the sibling quarantine directory. Returns the target paths.
 *
 * Target layout:
 *
 *     <parent>/_quarantined/<basename>-<YYYYMMDDTHHMMSSZ>/
 *       ├── <basename>
 *       ├── <basename>.provenance.json    (if it existed)
 *       └── reason.json
 *
 * The timestamp suffix is second-granularity UTC; two quarantines in
 * the same second of the same basename would collide, so in that
 * narrow case we append a `-1`, `-2`, ... counter to break the tie.
 *
 * Throws when `path` doesn't exist. Does not throw when the
 * provenance sidecar doesn't exist (sidecar is optional).
 */
export function quarantine(path: string, reason: string, opts: QuarantineOpts = {}): QuarantineResult {
  if (!existsSync(path)) {
    throw new Error(`quarantine: source does not exist: ${path}`);
  }

  const now = opts.now ?? new Date();
  const parent = dirname(path);
  const name = basename(path);
  const qdir = quarantineDir(parent);
  const ts = compactTimestamp(now);

  const targetDir = firstAvailable(join(qdir, `${name}-${ts}`));
  const movedTo = join(targetDir, name);
  const reasonFile = join(targetDir, 'reason.json');
  const sidecar = sidecarPathFor(path);
  const movedSidecar = sidecarPathFor(movedTo);

  if (opts.dryRun) {
    return { movedTo, reasonFile };
  }

  ensureDirSync(targetDir);
  renameSync(path, movedTo);

  if (existsSync(sidecar)) {
    renameSync(sidecar, movedSidecar);
  }

  const payload: QuarantineReason = {
    originalPath: path,
    reason,
    ts: now.toISOString(),
    ...(opts.caller ? { caller: opts.caller } : {}),
  };
  atomicWriteFile(reasonFile, JSON.stringify(payload, null, 2) + '\n');

  return { movedTo, reasonFile };
}

// ──────────────────────────────────────────────────────────────────────
// Failure counter.
// ──────────────────────────────────────────────────────────────────────

export interface FailureCounter {
  /**
   * Increment the counter for `id` by one. Returns the new value.
   * Atomic on a per-call basis: a partial write cannot corrupt the
   * counter file.
   */
  bump: (id: string) => number;
  /** Read the current count for `id`. Zero if unknown. */
  get: (id: string) => number;
  /**
   * Remove the entry for `id`. A subsequent `get(id)` returns zero.
   * No-op if the entry didn't exist. Atomic.
   */
  reset: (id: string) => void;
}

/**
 * Open a failure counter backed by `stateFile`. The file holds a
 * JSON object `{ [id: string]: number }`; corrupt files are treated
 * as empty state on read (a corrupted counter should not brick the
 * research pipeline — quarantine is still available).
 *
 * Each mutation rewrites the whole file atomically. Fine for the
 * expected scale (dozens of ids, hundreds of bumps per run); if a
 * future caller needs higher throughput we can swap in an append-log
 * backend without changing the interface.
 */
export function failureCounter(stateFile: string): FailureCounter {
  function load(): Record<string, number> {
    if (!existsSync(stateFile)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (!isRecord(parsed)) return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
          out[k] = v;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  function save(state: Record<string, number>): void {
    atomicWriteFile(stateFile, JSON.stringify(state, null, 2) + '\n');
  }

  return {
    bump(id) {
      const state = load();
      const next = (state[id] ?? 0) + 1;
      state[id] = next;
      save(state);
      return next;
    },
    get(id) {
      const state = load();
      return state[id] ?? 0;
    },
    reset(id) {
      const state = load();
      if (!(id in state)) return;
      delete state[id];
      save(state);
    },
  };
}
