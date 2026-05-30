/**
 * Minimal pure PNG -> RGBA decoder for the `avatar` extension.
 *
 * The kitty / iTerm2 paths hand raw PNG bytes to the terminal, which
 * decodes them. The sixel path has no such luxury: Windows Terminal can
 * only paint sixel, so we have to turn a PNG into pixels ourselves. This
 * decoder covers the cases ImageMagick emits for our sprites - 8-bit,
 * non-interlaced, colour types 0/2/3/4/6 - and returns `null` for anything
 * exotic (16-bit, interlaced) so callers can fall back to ASCII.
 *
 * Inflate uses the Node built-in `zlib`; everything else is hand-rolled to
 * stay dependency-free and unit-testable.
 */

import { inflateSync } from 'node:zlib';

export interface DecodedImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel, length `width * height * 4`. */
  rgba: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readUint32BE(data: Uint8Array, offset: number): number {
  return data[offset] * 0x1000000 + data[offset + 1] * 0x10000 + data[offset + 2] * 0x100 + data[offset + 3];
}

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

interface Chunks {
  header: Header;
  palette: Uint8Array | null;
  transparency: Uint8Array | null;
  idat: Uint8Array;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Walk the PNG chunk stream, collecting IHDR / PLTE / tRNS / IDAT. */
function readChunks(data: Uint8Array): Chunks | null {
  if (data.length < 8 + 12 + 13) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) return null;
  }

  let header: Header | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];

  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = readUint32BE(data, offset);
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > data.length) break;

    if (type === 'IHDR') {
      header = {
        width: readUint32BE(data, start),
        height: readUint32BE(data, start + 4),
        bitDepth: data[start + 8],
        colorType: data[start + 9],
        interlace: data[start + 12],
      };
    } else if (type === 'PLTE') {
      palette = data.subarray(start, end);
    } else if (type === 'tRNS') {
      transparency = data.subarray(start, end);
    } else if (type === 'IDAT') {
      idatParts.push(data.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4; // skip the trailing CRC
  }

  if (!header || idatParts.length === 0) return null;
  return { header, palette, transparency, idat: concat(idatParts) };
}

/** Bytes per pixel for an 8-bit-per-channel colour type, or 0 if unsupported. */
function channelsFor(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // grayscale
    case 2:
      return 3; // RGB
    case 3:
      return 1; // palette index
    case 4:
      return 2; // grayscale + alpha
    case 6:
      return 4; // RGBA
    default:
      return 0;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Reverse the per-scanline PNG filters in place, returning packed pixel bytes. */
function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array | null {
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;
  const out = new Uint8Array(height * stride);

  let rawAt = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawAt++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[rawAt++];
      const left = x >= bpp ? out[rowStart + x - bpp] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0;
      let recon: number;
      switch (filter) {
        case 0:
          recon = value;
          break;
        case 1:
          recon = value + left;
          break;
        case 2:
          recon = value + up;
          break;
        case 3:
          recon = value + ((left + up) >> 1);
          break;
        case 4:
          recon = value + paeth(left, up, upLeft);
          break;
        default:
          return null;
      }
      out[rowStart + x] = recon & 0xff;
    }
  }
  return out;
}

/** Expand unfiltered packed bytes into RGBA using the colour type + palette. */
function toRgba(packed: Uint8Array, chunks: Chunks): Uint8Array {
  const { width, height, colorType } = chunks.header;
  const { palette, transparency } = chunks;
  const count = width * height;
  const rgba = new Uint8Array(count * 4);

  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (colorType === 0) {
      const v = packed[i];
      const transparent = transparency !== null && transparency.length >= 2 && transparency[1] === v;
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = transparent ? 0 : 255;
    } else if (colorType === 2) {
      const p = i * 3;
      const r = packed[p];
      const g = packed[p + 1];
      const b = packed[p + 2];
      const transparent =
        transparency !== null &&
        transparency.length >= 6 &&
        transparency[1] === r &&
        transparency[3] === g &&
        transparency[5] === b;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = transparent ? 0 : 255;
    } else if (colorType === 3 && palette !== null) {
      const idx = packed[i];
      const p = idx * 3;
      rgba[o] = palette[p] ?? 0;
      rgba[o + 1] = palette[p + 1] ?? 0;
      rgba[o + 2] = palette[p + 2] ?? 0;
      rgba[o + 3] = transparency !== null && idx < transparency.length ? transparency[idx] : 255;
    } else if (colorType === 4) {
      const p = i * 2;
      const v = packed[p];
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = packed[p + 1];
    } else {
      const p = i * 4;
      rgba[o] = packed[p];
      rgba[o + 1] = packed[p + 1];
      rgba[o + 2] = packed[p + 2];
      rgba[o + 3] = packed[p + 3];
    }
  }
  return rgba;
}

/**
 * Decode `data` (a full PNG file) to RGBA, or return `null` for an
 * unsupported encoding (non-8-bit, interlaced, palette without PLTE) or a
 * malformed stream.
 */
export function decodePng(data: Uint8Array): DecodedImage | null {
  const chunks = readChunks(data);
  if (!chunks) return null;
  const { width, height, bitDepth, colorType, interlace } = chunks.header;
  if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0) return null;
  if (colorType === 3 && chunks.palette === null) return null;

  const bpp = channelsFor(colorType);
  if (bpp === 0) return null;

  let inflated: Uint8Array;
  try {
    inflated = inflateSync(chunks.idat);
  } catch {
    return null;
  }

  const packed = unfilter(inflated, width, height, bpp);
  if (!packed) return null;
  return { width, height, rgba: toRgba(packed, chunks) };
}
