/**
 * Pure PNG dimension reader for the `avatar` extension.
 *
 * The image renderers need pixel width/height to compute the cell rows
 * an avatar occupies. Reading the IHDR header directly avoids pulling a
 * decode library and keeps the helper unit-testable.
 */

import { hasPngSignature, readUint32BE } from '../png/binary.ts';

export interface PngDimensions {
  width: number;
  height: number;
}

/**
 * Parse the IHDR width/height from `data`, or return `null` when the
 * buffer is too short or not a PNG. IHDR width/height are big-endian
 * uint32s at byte offsets 16 and 20 (8-byte signature + 4-byte length +
 * 4-byte "IHDR" type).
 */
export function readPngDimensions(data: Uint8Array): PngDimensions | null {
  if (data.length < 24) return null;
  if (!hasPngSignature(data)) return null;
  const width = readUint32BE(data, 16);
  const height = readUint32BE(data, 20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}
