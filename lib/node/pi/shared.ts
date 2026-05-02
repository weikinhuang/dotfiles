/**
 * Small, dependency-free utilities shared across the other `lib/node/pi/*`
 * modules. No pi imports — testable under `vitest`.
 *
 * These helpers were previously duplicated (ellipsis truncation lived in
 * three separate modules with slightly different trim semantics; `byteLen`
 * and a `trimOrUndefined` pattern each had one copy but were obviously
 * reusable). Consolidating them here keeps fixes landing in one place
 * without pulling a full util library in.
 */

import { createHash } from 'node:crypto';

export interface TruncateOptions {
  /** Trim whitespace from `s` before measuring / slicing. Default false. */
  trim?: boolean;
}

/**
 * Cap `s` at `n` characters, appending `…` when the limit is hit. When
 * `trim` is enabled the input is trimmed first so callers don't need a
 * two-step `s.trim()` then `truncate()` dance.
 *
 * Guarantees:
 *   - Returns `s` (or the trimmed form) unchanged when it already fits.
 *   - When truncating, the returned string is exactly `n` chars long —
 *     `n - 1` original chars plus the `…` ellipsis.
 *   - `n <= 0` yields an empty string; `n === 1` yields just `…` when
 *     the input was longer than 0 chars (otherwise empty).
 */
export function truncate(s: string, n: number, opts: TruncateOptions = {}): string {
  const input = opts.trim ? s.trim() : s;
  if (n <= 0) return '';
  if (input.length <= n) return input;
  if (n === 1) return '…';
  return `${input.slice(0, n - 1)}…`;
}

/**
 * Trim `s`; return the trimmed form when non-empty, otherwise `undefined`.
 * Handy for optional fields where an empty string should clear the slot.
 */
export function trimOrUndefined(s: string | undefined): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Shared UTF-8 encoder. Exposed so callers that measure bytes in a tight
 * loop can reuse a single encoder instance instead of allocating.
 */
export const BYTE_ENCODER = new TextEncoder();

/** UTF-8 byte length of `s`. */
export function byteLen(s: string): number {
  return BYTE_ENCODER.encode(s).length;
}

// sha256 helpers — one shared implementation used by the three call
// sites that used to each instantiate `createHash('sha256')` on their
// own (`research-provenance.hashPrompt`, `research-sources` for
// cache-key + content-hash, `iteration-loop-storage` for snapshot
// fixpoint detection). Keeping the implementation in one place means a
// change in hashing policy (length, encoding, algorithm) lands in one
// file instead of three.

/**
 * Full hex sha256 of `input`. `Buffer` inputs are hashed as-is; string
 * inputs are encoded as UTF-8. Returns the standard 64-char lowercase
 * hex digest. Use for content-addressable keys where full collision
 * resistance matters (iteration-loop snapshot fixpoint, source-body
 * fingerprinting).
 */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * First `n` hex chars of sha256. Used for short display-friendly
 * fingerprints (provenance `promptHash`, source-cache `id`) where
 * collision probability at `n=12` over one run's worth of inputs is
 * well below the threshold we care about (~16M entries before a 1%
 * birthday-paradox chance). Throws on `n > 64` so accidental callers
 * asking for more than the digest length fail loudly instead of
 * getting silently-padded output.
 */
export function sha256HexPrefix(input: string | Buffer, n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 64) {
    throw new RangeError(`sha256HexPrefix: n must be an integer in [1, 64], got ${n}`);
  }
  return sha256Hex(input).slice(0, n);
}

/**
 * Type guard for "plain object" values — rejects `null`, arrays, and
 * scalars. The canonical first step in a structural validator before
 * reading properties off an untrusted payload (JSON from disk, model
 * output, session-entry state). Kept here so every validator shares
 * one definition of "record"; see the precedent in
 * `iteration-loop-schema.ts`.
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
