/**
 * Tests for lib/node/pi/avatar/sixel.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  SIXEL_IMAGE_LINE_MARKER,
  encodeSixel,
  resizeNearest,
  type RgbaImage,
} from '../../../../../lib/node/pi/avatar/sixel.ts';

const ESC = '\x1b';

/** Build a solid `width`x`height` image of one RGBA colour. */
function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width, height, rgba: data };
}

describe('resizeNearest', () => {
  test('reports the requested dimensions', () => {
    const out = resizeNearest(solid(4, 4, [1, 2, 3, 255]), 8, 2);
    expect(out.width).toBe(8);
    expect(out.height).toBe(2);
    expect(out.rgba.length).toBe(8 * 2 * 4);
  });

  test('downscaling samples the source colour', () => {
    const out = resizeNearest(solid(10, 10, [200, 100, 50, 255]), 3, 3);
    expect(Array.from(out.rgba.subarray(0, 4))).toEqual([200, 100, 50, 255]);
  });
});

describe('encodeSixel', () => {
  test('wraps output in a DCS sequence with a raster header', () => {
    const out = encodeSixel(solid(6, 1, [255, 0, 0, 255]));
    expect(out.startsWith(`${ESC}P0;1;0q"1;1;6;1`)).toBe(true);
    expect(out.endsWith(`${ESC}\\`)).toBe(true);
  });

  test('emits a colour register (0-100 scale) and run-length data', () => {
    const out = encodeSixel(solid(6, 1, [255, 0, 0, 255]));
    // Pure red -> register 0 at full red on the 0-100 scale.
    expect(out).toContain('#0;2;100;0;0');
    // One band, one set row (bit 0) repeated 6x -> RLE of sixel char '@' (63 + 1).
    expect(out).toContain('#0!6@');
  });

  test('leaves fully transparent images with no colour registers', () => {
    const out = encodeSixel(solid(4, 4, [10, 20, 30, 0]));
    expect(out).not.toContain(';2;');
    expect(out.startsWith(`${ESC}P`)).toBe(true);
    expect(out.endsWith(`${ESC}\\`)).toBe(true);
  });
});

describe('SIXEL_IMAGE_LINE_MARKER', () => {
  test('is an empty kitty graphics APC command', () => {
    // pi-tui's isImageLine() matches any line containing the kitty `ESC _G`
    // prefix, so this no-op APC exempts a sixel line from the width guard.
    expect(SIXEL_IMAGE_LINE_MARKER).toBe(`${ESC}_Gm=0;${ESC}\\`);
    expect(SIXEL_IMAGE_LINE_MARKER.startsWith(`${ESC}_G`)).toBe(true);
    expect(SIXEL_IMAGE_LINE_MARKER.endsWith(`${ESC}\\`)).toBe(true);
  });

  test('prefixing a sixel sequence keeps the DCS payload intact', () => {
    const line = SIXEL_IMAGE_LINE_MARKER + encodeSixel(solid(6, 1, [255, 0, 0, 255]));
    expect(line.startsWith(`${ESC}_G`)).toBe(true);
    expect(line).toContain(`${ESC}P0;1;0q"1;1;6;1`);
    expect(line.endsWith(`${ESC}\\`)).toBe(true);
  });
});
