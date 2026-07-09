/**
 * Shared low-level PNG byte primitives: the 8-byte file signature, a
 * signature check, and a big-endian uint32 reader.
 *
 * Several helpers walk raw PNG bytes for different reasons (avatar
 * dimension + RGBA decode, image-ref MIME sniffing, character-card
 * `tEXt` extraction) and each had re-rolled the same signature array and
 * `readUint32BE`. Centralising them keeps one definition of the wire
 * format so a fix (e.g. an out-of-bounds guard) lands everywhere.
 *
 * Pure module - no pi imports, takes bytes in rather than reading files,
 * so it runs under vitest without touching the filesystem.
 */

/** The 8 bytes every PNG file begins with. */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True when `bytes` begins with the 8-byte PNG signature. */
export function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

/**
 * Read a big-endian unsigned 32-bit integer at `offset`. Missing bytes
 * (offset past the end) read as 0 rather than producing `NaN`. The
 * additive form keeps the result unsigned without a `>>> 0` fixup - the
 * max value `0xFFFFFFFF` is exactly representable as a double.
 */
export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    (bytes[offset + 1] ?? 0) * 0x10000 +
    (bytes[offset + 2] ?? 0) * 0x100 +
    (bytes[offset + 3] ?? 0)
  );
}
