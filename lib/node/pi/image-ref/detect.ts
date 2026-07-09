/**
 * Magic-byte image sniffing for the `image-ref` extension.
 *
 * Pi's own `@file` path sniffs the same four formats (see pi's
 * `utils/mime.ts`), but that helper is NOT exported from
 * `@earendil-works/pi-coding-agent`, so we keep a self-contained,
 * unit-testable copy here. The byte signatures and the
 * animated-PNG / CMYK-JPEG rejections mirror pi's logic so an image
 * the extension attaches is one pi (and the provider) would also
 * accept.
 *
 * Pure module - no pi imports, takes bytes in rather than reading
 * files, so it runs under vitest without touching the filesystem.
 */

import { PNG_SIGNATURE, hasPngSignature, readUint32BE } from '../png/binary.ts';

/** MIME types pi (and every vision provider here) accepts inline. */
export type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function startsWith(buffer: Uint8Array, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

function startsWithAscii(buffer: Uint8Array, offset: number, ascii: string): boolean {
  if (buffer.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (buffer[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

function isPng(buffer: Uint8Array): boolean {
  // First chunk after the signature must be a 13-byte IHDR.
  return (
    buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, 'IHDR')
  );
}

/**
 * APNG carries an `acTL` chunk before the first `IDAT`. Vision
 * providers treat PNG as a still frame, so reject animated ones the
 * way pi does rather than send a misleading first frame.
 */
function isAnimatedPng(buffer: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = readUint32BE(buffer, offset);
    if (startsWithAscii(buffer, offset + 4, 'acTL')) return true;
    if (startsWithAscii(buffer, offset + 4, 'IDAT')) return false;
    // Advance past length(4) + type(4) + data(length) + crc(4).
    offset += 12 + length;
  }
  return false;
}

/**
 * Sniff `buffer` (the leading bytes of a file are enough) and return
 * the supported MIME type, or `null` when the content is not one of
 * the four inline-safe formats. Mirrors pi's `detectSupportedImageMimeType`.
 */
export function sniffImageMime(buffer: Uint8Array): SupportedImageMime | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    // 0xFFD8FFF7 is a CMYK / lossless JPEG variant providers choke on.
    return buffer[3] === 0xf7 ? null : 'image/jpeg';
  }
  if (hasPngSignature(buffer)) {
    return isPng(buffer) && !isAnimatedPng(buffer) ? 'image/png' : null;
  }
  if (startsWithAscii(buffer, 0, 'GIF')) {
    return 'image/gif';
  }
  if (startsWithAscii(buffer, 0, 'RIFF') && startsWithAscii(buffer, 8, 'WEBP')) {
    return 'image/webp';
  }
  return null;
}

/** Bytes to read from the head of a file for {@link sniffImageMime}. */
export const SNIFF_BYTES = 4100;
