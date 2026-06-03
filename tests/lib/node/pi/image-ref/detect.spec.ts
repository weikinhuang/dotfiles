/**
 * Tests for lib/node/pi/image-ref/detect.ts.
 */

import { describe, expect, test } from 'vitest';

import { sniffImageMime } from '../../../../../lib/node/pi/image-ref/detect.ts';

const PNG_HEADER = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // signature
  0x00,
  0x00,
  0x00,
  0x0d, // IHDR length = 13
  0x49,
  0x48,
  0x44,
  0x52, // "IHDR"
]);

function pngWithChunk(type: string): Buffer {
  // signature + IHDR(13) + a chunk of the given type before any IDAT.
  const chunk = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // length 0
    Buffer.from(type, 'ascii'),
  ]);
  return Buffer.concat([PNG_HEADER, Buffer.alloc(13), Buffer.from([0, 0, 0, 0]), chunk]);
}

describe('sniffImageMime', () => {
  test('detects JPEG by signature', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  test('rejects the CMYK/lossless JPEG variant (0xFFD8FFF7)', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xf7]))).toBeNull();
  });

  test('detects a still PNG with a valid IHDR', () => {
    expect(sniffImageMime(pngWithChunk('IDAT'))).toBe('image/png');
  });

  test('rejects an animated PNG (acTL before IDAT)', () => {
    expect(sniffImageMime(pngWithChunk('acTL'))).toBeNull();
  });

  test('rejects a PNG signature without a valid IHDR', () => {
    expect(sniffImageMime(PNG_HEADER.subarray(0, 8))).toBeNull();
  });

  test('detects GIF and WEBP', () => {
    expect(sniffImageMime(Buffer.from('GIF89a', 'ascii'))).toBe('image/gif');
    const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')]);
    expect(sniffImageMime(webp)).toBe('image/webp');
  });

  test('returns null for non-image bytes', () => {
    expect(sniffImageMime(Buffer.from('not an image', 'ascii'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});
