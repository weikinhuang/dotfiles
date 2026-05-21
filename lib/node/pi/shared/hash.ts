/**
 * Shared sha256 helpers - one implementation used by every call site
 * that previously instantiated `createHash('sha256')` on its own
 * (`research-provenance.hashPrompt`, `research-sources` for cache-key
 * + content-hash, `iteration-loop-storage` for snapshot fixpoint
 * detection, …). Keeping the implementation in one place means a
 * change in hashing policy (length, encoding, algorithm) lands in one
 * file instead of several.
 */

import { createHash } from 'node:crypto';

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
