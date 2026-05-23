/**
 * Atomic file-write primitives used across pi helpers.
 *
 * Writing in place can leave a half-written file if the process dies
 * mid-write. The standard fix is "write to a temp file, then rename":
 * POSIX `rename(2)` is atomic on the same filesystem, so the destination
 * either has the full old bytes or the full new bytes - never a mix.
 *
 * Two minor policies applied on top:
 *   - The temp suffix includes `${pid}-${Date.now()}-${counter}` so
 *     concurrent writers (two processes, or two callers in the same
 *     process racing on the same path) don't stomp each other's temp
 *     file. A static `.tmp` suffix is ambiguous under concurrency.
 *   - Parent directory is `mkdir -p`-ed first so callers don't need to
 *     know whether the path already exists.
 *
 * No `fsync` - the caller's "atomicity" needs are satisfied by the
 * rename barrier. Durability under power loss would require fsync of
 * both the tempfile and the parent dir, which is slow enough that we
 * only want it gated behind an opt-in flag. Not needed today.
 *
 * This module replaces two older per-feature implementations:
 *   - `memory-paths.ts::atomicWriteFile` (static `.tmp` suffix - racy)
 *   - `iteration-loop-storage.ts::atomicWriteFile` (pid+ts suffix)
 * Both now delegate here.
 *
 * No pi imports - testable under `vitest` with a temp cwd.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * `mkdir -p <path>`. Safe to call on an existing directory. Exported
 * so callers that already hold a dir path don't have to re-derive the
 * mkdir recipe; tempfile + rename callers go through `atomicWriteFile`.
 */
export function ensureDirSync(path: string): void {
  mkdirSync(path, { recursive: true });
}

// Monotonic-within-process counter so two calls in the same Date.now()
// millisecond still produce distinct temp paths.
let writeCounter = 0;

/**
 * Write `body` to `path` atomically (write to a unique tempfile in the
 * same directory, then rename). Creates parent dirs as needed.
 *
 * `body` accepts both strings and Buffers; strings are encoded as UTF-8
 * by `writeFileSync`'s default behavior, matching prior call sites.
 */
export function atomicWriteFile(path: string, body: string | Buffer): void {
  ensureDirSync(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++writeCounter}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

/**
 * Pretty-print `value` as 2-space-indented JSON with a trailing newline
 * and write it to `path`. Creates parent dirs as needed (atomic NOT
 * required - JSON config files are short and the slash-command-driven
 * call sites are not racy across pi processes).
 *
 * The trailing newline matches the convention `oxfmt` enforces for the
 * repo's own JSONC fixtures, so a config file written here passes
 * through `git diff` cleanly even after a hand-edit/round-trip.
 *
 * Used by the slash-command write paths in `bash-permissions`,
 * `sandbox`, and any other extension that round-trips a JSON(C) config
 * file via {@link readJsoncForMutation}. Bypasses the comment-preserving
 * round-trip on purpose: comments survive `parseJsonc` reads but the
 * structured value loses them; a write-back replaces the file's
 * structural content while leaving us free to keep the schema simple.
 */
export function writeJsonFile(path: string, value: unknown): void {
  ensureDirSync(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
