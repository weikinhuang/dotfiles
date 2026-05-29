/**
 * Tests for lib/node/pi/avatar/png.ts.
 */

import { describe, expect, test } from 'vitest';

import { readPngDimensions } from '../../../../../lib/node/pi/avatar/png.ts';

/** Build a minimal buffer with a valid PNG signature + IHDR width/height. */
function makePng(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // bytes 8-15: IHDR length + type (content irrelevant to the reader)
  const writeBE = (offset: number, value: number): void => {
    buf[offset] = (value >>> 24) & 0xff;
    buf[offset + 1] = (value >>> 16) & 0xff;
    buf[offset + 2] = (value >>> 8) & 0xff;
    buf[offset + 3] = value & 0xff;
  };
  writeBE(16, width);
  writeBE(20, height);
  return buf;
}

describe('readPngDimensions', () => {
  test('reads width/height from a valid IHDR', () => {
    expect(readPngDimensions(makePng(510, 510))).toEqual({ width: 510, height: 510 });
    expect(readPngDimensions(makePng(64, 32))).toEqual({ width: 64, height: 32 });
  });

  test('handles large dimensions without sign issues', () => {
    expect(readPngDimensions(makePng(100000, 1))).toEqual({ width: 100000, height: 1 });
  });

  test('returns null for a too-short buffer', () => {
    expect(readPngDimensions(new Uint8Array(10))).toBeNull();
  });

  test('returns null when the signature is wrong', () => {
    const bad = makePng(10, 10);
    bad[0] = 0x00;
    expect(readPngDimensions(bad)).toBeNull();
  });

  test('returns null for zero dimensions', () => {
    expect(readPngDimensions(makePng(0, 10))).toBeNull();
  });
});
