/**
 * UTF-8 byte utilities. The encoder is exposed so callers that measure
 * bytes in a tight loop can reuse a single instance instead of
 * allocating a new `TextEncoder` per call.
 */

/**
 * Shared UTF-8 encoder. Exposed so callers that measure bytes in a
 * tight loop can reuse a single encoder instance instead of allocating.
 */
export const BYTE_ENCODER = new TextEncoder();

/** UTF-8 byte length of `s`. */
export function byteLen(s: string): number {
  return BYTE_ENCODER.encode(s).length;
}

/** Compact byte count used in condensed-output banners (for example, `1.0KB`). */
export function formatCompactBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}
