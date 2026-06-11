/**
 * Tests for config/pi/avatar/tools/slice-sheets.ts pure helpers.
 *
 * The magick-driven parts (chromaMask, detectBackgroundColor, writeCell) need
 * ImageMagick + real images, so only the pure color helpers are unit-tested
 * here. main() is import-guarded, so importing the module does not run the CLI.
 */

import { describe, expect, test } from 'vitest';

import {
  alignArgs,
  bandsToCells,
  bordersToBoxes,
  findBands,
  parsePixel,
  pickBackgroundColor,
  regularizeBoxes,
} from '../../../../../config/pi/avatar/tools/slice-sheets.ts';

describe('parsePixel', () => {
  test('parses srgb() and srgba()', () => {
    expect(parsePixel('srgb(143,174,143)')).toEqual([143, 174, 143]);
    expect(parsePixel('srgba(0,255,0,1)')).toEqual([0, 255, 0]);
    expect(parsePixel('rgb(10, 20, 30)')).toEqual([10, 20, 30]);
  });

  test('parses #rrggbb and #rgb hex', () => {
    expect(parsePixel('#00ff00')).toEqual([0, 255, 0]);
    expect(parsePixel('#0f0')).toEqual([0, 255, 0]);
    expect(parsePixel('  #8FAE8F  ')).toEqual([143, 174, 143]);
  });

  test('clamps out-of-range channel values', () => {
    expect(parsePixel('srgb(300,400,128)')).toEqual([255, 255, 128]);
  });

  test('returns undefined for unrecognized strings', () => {
    expect(parsePixel('not a color')).toBeUndefined();
    expect(parsePixel('')).toBeUndefined();
  });
});

describe('pickBackgroundColor', () => {
  test('returns the dominant flat background as srgb()', () => {
    const samples = ['srgb(142,173,142)', 'srgb(143,174,143)', 'srgb(144,175,144)', 'srgb(143,174,143)'];
    expect(pickBackgroundColor(samples, '#00FF00')).toBe('srgb(143,174,143)');
  });

  test('a minority of art-clipping samples do not move the detected background', () => {
    // Nine background samples (spring-green) + two character outliers: the
    // background bucket dominates, so detection still keys the real green
    // rather than falling back.
    const samples = [
      'srgb(0,255,131)',
      'srgb(0,255,130)',
      'srgb(1,255,132)',
      'srgb(0,254,131)',
      'srgb(0,255,129)',
      'srgb(2,255,131)',
      'srgb(0,255,131)',
      'srgb(1,255,130)',
      'srgb(0,255,132)',
      'srgb(200,30,40)',
      'srgb(245,245,245)',
    ];
    expect(pickBackgroundColor(samples, '#00FF00')).toBe('srgb(0,255,131)');
  });

  test('falls back when fewer than three samples parse', () => {
    expect(pickBackgroundColor(['garbage', 'srgb(0,255,0)'], '#00FF00')).toBe('#00FF00');
  });

  test('falls back when no color clusters into a majority (not a flat-bg sheet)', () => {
    const samples = ['srgb(10,20,30)', 'srgb(90,90,90)', 'srgb(200,40,40)', 'srgb(0,120,255)'];
    expect(pickBackgroundColor(samples, '#00FF00')).toBe('#00FF00');
  });
});

describe('alignArgs', () => {
  test('box does not trim: fits aspect-preserving and pins top-center', () => {
    expect(alignArgs('box', { w: 320, h: 320 }, 'lanczos')).toEqual([
      '-filter',
      'lanczos',
      '-resize',
      '320x320',
      '-background',
      'none',
      '-gravity',
      'North',
      '-extent',
      '320x320',
    ]);
  });

  test("box never trims (constant scale keeps a state's frames from zooming/shifting)", () => {
    expect(alignArgs('box', { w: 320, h: 320 }, 'point')).not.toContain('-trim');
  });

  test('north trims, fits aspect-preserving, then re-pads top-center', () => {
    expect(alignArgs('north', { w: 320, h: 320 }, 'lanczos')).toEqual([
      '-trim',
      '+repage',
      '-filter',
      'lanczos',
      '-resize',
      '320x320',
      '-background',
      'none',
      '-gravity',
      'North',
      '-extent',
      '320x320',
    ]);
  });

  test('center uses Center gravity and threads the chosen filter', () => {
    const args = alignArgs('center', { w: 320, h: 320 }, 'point');
    expect(args).toContain('Center');
    expect(args.slice(args.indexOf('-filter'), args.indexOf('-filter') + 2)).toEqual(['-filter', 'point']);
    expect(args).not.toContain('320x320!');
  });

  test('none force-fills the canvas (legacy, no trim/extent)', () => {
    expect(alignArgs('none', { w: 320, h: 320 }, 'lanczos')).toEqual(['-filter', 'lanczos', '-resize', '320x320!']);
  });
});

describe('findBands', () => {
  const opts = { threshold: 40, minLen: 2, mergeGap: 3 };

  test('finds runs above threshold and drops short ones', () => {
    // run 2..4 (len 3) kept; lone high at index 10 (gap 5 > mergeGap) dropped (len 1 < minLen)
    const p = [0, 0, 99, 99, 99, 0, 0, 0, 0, 0, 99, 0];
    expect(findBands(p, opts)).toEqual([[2, 4]]);
  });

  test('merges runs separated by <= mergeGap but keeps wider-apart pairs', () => {
    expect(findBands([99, 99, 99, 99, 0, 0, 99, 99, 99, 99], opts)).toEqual([[0, 9]]);
    expect(findBands([99, 99, 0, 0, 0, 0, 0, 99, 99], opts)).toEqual([
      [0, 1],
      [7, 8],
    ]);
  });
});

describe('bandsToCells / bordersToBoxes', () => {
  test('pairs strokes into interiors just inside each box', () => {
    expect(
      bandsToCells([
        [6, 12],
        [372, 378],
        [390, 396],
        [755, 761],
      ]),
    ).toEqual([
      [13, 371],
      [397, 754],
    ]);
  });

  test('bordersToBoxes returns null unless 2*cols and 2*rows strokes are present', () => {
    const tooFew: [number, number][] = [
      [0, 2],
      [10, 12],
    ];
    expect(bordersToBoxes(tooFew, tooFew)).toBeNull();
  });
});

describe('regularizeBoxes', () => {
  // 4x3 grid of jittery boxes: widths/heights and column-x / row-y wobble a few px.
  const grid = (): { x: number; y: number; w: number; h: number }[] => {
    const colX = [10, 110, 210, 310];
    const rowY = [10, 110, 210];
    const out: { x: number; y: number; w: number; h: number }[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        // wobble every other cell so medians still land on the canonical value
        const jx = c % 2 === 0 ? 0 : 3;
        const jy = r % 2 === 0 ? 0 : 2;
        out.push({ x: colX[c] + jx, y: rowY[r] + jy, w: 80 + jx, h: 80 + jy });
      }
    }
    return out;
  };

  test('snaps every cell to a uniform size and evenly-aligned columns/rows', () => {
    const reg = regularizeBoxes(grid());
    // all cells share one width; column-x is constant down each column
    const widths = new Set(reg.map((b) => b.w));
    expect(widths.size).toBe(1);
    for (let c = 0; c < 4; c++) {
      const xs = new Set([reg[c].x, reg[c + 4].x, reg[c + 8].x]);
      expect(xs.size).toBe(1);
    }
    for (let r = 0; r < 3; r++) {
      const ys = new Set([reg[r * 4].y, reg[r * 4 + 1].y, reg[r * 4 + 2].y, reg[r * 4 + 3].y]);
      expect(ys.size).toBe(1);
    }
  });

  test('extends each cell bottom by the inter-row gap so chest overflow is kept', () => {
    const reg = regularizeBoxes(grid());
    // rows pitch 100, median cell height 80 -> gap ~20, so h ends up > the raw 80
    expect(reg[0].h).toBeGreaterThan(80);
  });

  test('returns the input unchanged when the box count is not cols*rows', () => {
    const partial = [{ x: 0, y: 0, w: 1, h: 1 }];
    expect(regularizeBoxes(partial)).toEqual(partial);
  });
});
