/**
 * Pure PNG dimension reader for the `avatar` extension.
 *
 * The image renderers need pixel width/height to compute the cell rows
 * an avatar occupies. Reading the IHDR header directly avoids pulling a
 * decode library and keeps the helper unit-testable.
 */

export interface PngDimensions {
  width: number;
  height: number;
}

/** First 8 bytes of every PNG file. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Read a big-endian uint32 at `offset`. */
function readUint32BE(data: Uint8Array, offset: number): number {
  return data[offset] * 0x1000000 + data[offset + 1] * 0x10000 + data[offset + 2] * 0x100 + data[offset + 3];
}

/**
 * Parse the IHDR width/height from `data`, or return `null` when the
 * buffer is too short or not a PNG. IHDR width/height are big-endian
 * uint32s at byte offsets 16 and 20 (8-byte signature + 4-byte length +
 * 4-byte "IHDR" type).
 */
export function readPngDimensions(data: Uint8Array): PngDimensions | null {
  if (data.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) return null;
  }
  const width = readUint32BE(data, 16);
  const height = readUint32BE(data, 20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}
