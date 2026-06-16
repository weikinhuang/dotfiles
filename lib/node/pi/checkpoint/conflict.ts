/**
 * Classify each resolved file target against the file's CURRENT bytes on
 * disk, producing the {@link FileStatus} the review uses to pick row
 * defaults (no-op rows hidden, conflict rows opt-in, clean rows checked).
 *
 * The rule, per file (disk hash is `null` when the file is absent on disk,
 * mirroring a `null` target / expectedCurrent):
 *
 *   - disk == target          ⇒ `no-op`          (already where we're going)
 *   - disk == expectedCurrent ⇒ `clean-restore`  (a clean swap)
 *   - otherwise               ⇒ `conflict`       (edited out-of-band)
 *
 * `no-op` is checked first so a file that happens to equal both the target
 * and the expected-current (a net no-change move) is reported as a no-op
 * rather than a clean-restore - there's nothing to do either way.
 *
 * No pi imports - operates on hashes the shell computed from disk + blobs.
 */

import type { FileStatus, FileTarget } from './types.ts';

/**
 * Classify one file. `diskHash` is the sha256 of the file's current bytes,
 * or `null` if the file does not currently exist.
 */
export function classifyFile(target: FileTarget, diskHash: string | null): FileStatus {
  if (diskHash === target.target) return 'no-op';
  if (diskHash === target.expectedCurrent) return 'clean-restore';
  return 'conflict';
}

/** One classified row: the resolved target plus its disk status. */
export interface ClassifiedFile {
  target: FileTarget;
  status: FileStatus;
  /** sha256 of current disk bytes, or null if absent - carried for diffing. */
  diskHash: string | null;
}

/**
 * Classify every target against `diskHashes` (keyed by path; a missing key
 * is treated as `null` = file absent). Order follows the input `targets`.
 */
export function classifyTargets(
  targets: readonly FileTarget[],
  diskHashes: ReadonlyMap<string, string | null>,
): ClassifiedFile[] {
  return targets.map((target) => {
    const diskHash = diskHashes.has(target.path) ? (diskHashes.get(target.path) ?? null) : null;
    return { target, status: classifyFile(target, diskHash), diskHash };
  });
}
