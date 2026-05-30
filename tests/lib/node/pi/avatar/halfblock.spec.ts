/**
 * Tests for lib/node/pi/avatar/halfblock.ts.
 */

import { describe, expect, test } from 'vitest';

import { encodeHalfblock } from '../../../../../lib/node/pi/avatar/halfblock.ts';
import { type RgbaImage } from '../../../../../lib/node/pi/avatar/sixel.ts';

const ESC = '\x1b';
const TOP = '\u2580';
const BOT = '\u2584';
const RESET = `${ESC}[0m`;

/** Strip SGR (`CSI ... m`) sequences so the remaining string is just glyphs. */
const SGR_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
function stripSgr(s: string): string {
  return s.replaceAll(SGR_RE, '');
}

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

describe('encodeHalfblock', () => {
  test('produces ceil(height / 2) lines', () => {
    expect(encodeHalfblock(solid(4, 1, [10, 20, 30, 255])).length).toBe(1);
    expect(encodeHalfblock(solid(4, 2, [10, 20, 30, 255])).length).toBe(1);
    expect(encodeHalfblock(solid(4, 3, [10, 20, 30, 255])).length).toBe(2);
    expect(encodeHalfblock(solid(4, 6, [10, 20, 30, 255])).length).toBe(3);
  });

  test('every line ends with an SGR reset', () => {
    const lines = encodeHalfblock(solid(3, 4, [255, 128, 64, 255]));
    for (const line of lines) {
      expect(line.endsWith(RESET)).toBe(true);
    }
  });

  test('stripped SGR width equals image pixel width (one glyph per column)', () => {
    const lines = encodeHalfblock(solid(7, 4, [200, 100, 50, 255]));
    for (const line of lines) {
      // One glyph per column: `▀` / `▄` / space are all single-unit BMP chars.
      expect(stripSgr(line).length).toBe(7);
    }
  });

  test('two opaque rows emit fg+bg with the upper half block glyph', () => {
    // Top row red, bottom row green.
    const img: RgbaImage = {
      width: 1,
      height: 2,
      rgba: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
    };
    const [line] = encodeHalfblock(img);
    expect(line).toContain(`${ESC}[38;2;255;0;0;48;2;0;255;0m${TOP}`);
    expect(line.endsWith(RESET)).toBe(true);
  });

  test('top-opaque + bottom-transparent emits fg with default bg + upper block', () => {
    const img: RgbaImage = {
      width: 1,
      height: 2,
      rgba: new Uint8Array([10, 20, 30, 255, 0, 0, 0, 0]),
    };
    const [line] = encodeHalfblock(img);
    expect(line).toContain(`${ESC}[38;2;10;20;30;49m${TOP}`);
  });

  test('top-transparent + bottom-opaque emits fg with default bg + lower block', () => {
    const img: RgbaImage = {
      width: 1,
      height: 2,
      rgba: new Uint8Array([0, 0, 0, 0, 40, 50, 60, 255]),
    };
    const [line] = encodeHalfblock(img);
    expect(line).toContain(`${ESC}[38;2;40;50;60;49m${BOT}`);
  });

  test('both transparent yields a default-bg space', () => {
    const img: RgbaImage = {
      width: 2,
      height: 2,
      rgba: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    };
    const [line] = encodeHalfblock(img);
    expect(line).toContain(`${ESC}[49m `);
    expect(stripSgr(line)).toBe('  ');
  });

  test('odd image height: trailing single row paints as top-only (upper block)', () => {
    // 1 col x 1 row: only the top half is opaque; bottom is "missing".
    const [line] = encodeHalfblock(solid(1, 1, [11, 22, 33, 255]));
    expect(line).toContain(`${ESC}[38;2;11;22;33;49m${TOP}`);
  });
});
