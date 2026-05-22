/**
 * JSONL audit log for sandbox violations at
 * `<piAgentDir>/sandbox-violations.log` with size-rotation. Pi crashes lose
 * any in-memory `SandboxViolationStore` entries; this preserves the
 * evidence the user actually wants when investigating a block.
 *
 * Format: one JSON object per line. Fields are kept compact so
 * `tail -n` + `jq` is comfortable.
 *
 *   {"ts":"2026-05-20T13:14:15.000Z","kind":"fs","action":"deny-read",
 *    "path":"/Users/x/.ssh/id_rsa","command":"cat ...","cwd":"/repo"}
 *
 * Pure module - no pi imports - so it's directly unit-testable. The
 * append goes through `atomic-write`'s primitives so two pi sessions
 * writing concurrently can't tear a record. Rotation is triggered
 * lazily on each append: when the file exceeds the rotation threshold,
 * it's renamed to `<path>.1` (overwriting any previous `.1`) before
 * the new record is written. We deliberately keep only ONE backup -
 * full retention is out of scope for the v1 audit channel.
 */

import { renameSync, statSync, appendFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { ensureDirSync } from '../atomic-write.ts';
import { byteLen } from '../shared.ts';

/** 5 MiB rotation cap matches plan section 3.2. */
export const DEFAULT_VIOLATIONS_LOG_MAX_BYTES = 5 * 1024 * 1024;

export type SandboxViolationKind = 'fs' | 'net' | 'unix-socket' | 'other';

export interface SandboxViolationRecord {
  /** ISO-8601 timestamp; supplied by caller for testability. */
  ts: string;
  /** Coarse channel - filesystem, network, unix socket, or fallback. */
  kind: SandboxViolationKind;
  /** ASRT's verb when available, or a synthesized one (`deny-read`,
   *  `deny-connect`). */
  action: string;
  /** The user command that triggered the violation. */
  command: string;
  /** cwd at spawn time. */
  cwd: string;
  /** Filesystem path the violation involved. Optional - network
   *  violations omit it. */
  path?: string;
  /** Network host:port the violation involved. Optional. */
  host?: string;
  /** Free-form note (rotation marker, fallback wrap path, etc.). */
  note?: string;
}

export interface AppendOptions {
  /** Override the rotation threshold (in bytes). Tests pass a tiny
   *  value to exercise rotation without filling the disk. */
  maxBytes?: number;
}

/**
 * Atomically append `record` to `logPath`, rotating to `<logPath>.1`
 * first if the existing file would exceed `maxBytes` AFTER the append.
 *
 * Returns metadata so callers can render "rotated" badges or surface
 * rotation events back to the user via `/sandbox`.
 */
export function appendViolation(
  logPath: string,
  record: SandboxViolationRecord,
  options: AppendOptions = {},
): { wrote: number; rotated: boolean; rotatedTo?: string } {
  const maxBytes = options.maxBytes ?? DEFAULT_VIOLATIONS_LOG_MAX_BYTES;
  ensureDirSync(dirname(logPath));

  const line = `${JSON.stringify(record)}\n`;
  const bytesLine = byteLen(line);

  let rotated = false;
  let rotatedTo: string | undefined;

  if (existsSync(logPath)) {
    let size = 0;
    try {
      size = statSync(logPath).size;
    } catch {
      // Race: someone else just rotated. Treat as size 0 and proceed.
      size = 0;
    }
    if (size > 0 && size + bytesLine > maxBytes) {
      const target = `${logPath}.1`;
      try {
        renameSync(logPath, target);
        rotated = true;
        rotatedTo = target;
      } catch {
        // Rotation failed (cross-device, permission, …); keep
        // appending to the existing file rather than dropping the
        // record.
      }
    }
  }

  appendFileSync(logPath, line);
  return { wrote: bytesLine, rotated, rotatedTo };
}

// ──────────────────────────────────────────────────────────────────────
// Reader
// ──────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';

export interface ReadViolationsOptions {
  /** Max number of records to return (most recent first). */
  limit?: number;
  /** Optional kind filter (rendered in `/sandbox` as `--net` / `--fs`). */
  kind?: SandboxViolationKind;
}

/**
 * Read up to `limit` records from `logPath` (newest first), tolerating
 * malformed lines (skipped silently). Reads the rotated `.1` backup
 * too when the live file alone doesn't satisfy `limit`.
 */
export function readViolations(logPath: string, options: ReadViolationsOptions = {}): SandboxViolationRecord[] {
  const { limit = 100, kind } = options;
  const out: SandboxViolationRecord[] = [];

  // Read rotated backup first (older), then live file. Keep newest at
  // the front of `out`.
  for (const path of [logPath, `${logPath}.1`]) {
    if (out.length >= limit) break;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (out.length >= limit) break;
      const line = lines[i];
      if (!line) continue;
      try {
        const rec = JSON.parse(line) as SandboxViolationRecord;
        if (!rec || typeof rec !== 'object') continue;
        if (kind && rec.kind !== kind) continue;
        out.push(rec);
      } catch {
        continue;
      }
    }
  }

  return out;
}
