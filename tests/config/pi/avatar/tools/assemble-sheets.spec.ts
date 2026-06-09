/**
 * Tests for config/pi/avatar/tools/assemble-sheets.ts pure geometry + the
 * magick argument builder.
 *
 * Pure module - no disk or network needed.
 */

import { describe, expect, test } from 'vitest';

import { BORDER, CHROMA } from '../../../../../config/pi/avatar/tools/sprite-manifest.ts';
import {
  cellOrigin,
  type Geom,
  montageArgs,
  type Placement,
  sheetSize,
} from '../../../../../config/pi/avatar/tools/assemble-sheets.ts';

const geom: Geom = { cell: 512, gutter: 32, border: 8, cols: 4, rows: 3 };

describe('sheetSize', () => {
  test('accounts for every cell plus the surrounding gutters', () => {
    expect(sheetSize(geom)).toEqual({
      w: 4 * 512 + 5 * 32,
      h: 3 * 512 + 4 * 32,
    });
  });
});

describe('cellOrigin', () => {
  test('first cell sits one gutter in from the top-left margin', () => {
    expect(cellOrigin(0, geom)).toEqual({ x: 32, y: 32 });
  });

  test('walks reading order: across columns, then down rows', () => {
    expect(cellOrigin(1, geom)).toEqual({ x: 32 + (512 + 32), y: 32 });
    expect(cellOrigin(4, geom)).toEqual({ x: 32, y: 32 + (512 + 32) });
    expect(cellOrigin(5, geom)).toEqual({ x: 32 + (512 + 32), y: 32 + (512 + 32) });
  });
});

describe('montageArgs', () => {
  const placements: Placement[] = [
    { index: 0, file: 'gen/kontext/hi.0.png' },
    { index: 5, file: 'gen/kontext/idle.1.png' },
  ];

  test('starts with a CHROMA canvas sized to the full sheet', () => {
    const args = montageArgs(placements, geom, 'out/activities.1.png');
    const { w, h } = sheetSize(geom);
    expect(args.slice(0, 3)).toEqual(['-size', `${w}x${h}`, `xc:${CHROMA}`]);
    expect(args.at(-1)).toBe('out/activities.1.png');
  });

  test('flattens each cell onto CHROMA and frames it with the cyan BORDER', () => {
    const args = montageArgs(placements, geom, 'out/activities.1.png');
    const inner = 512 - 2 * 8;
    expect(args).toContain('-background');
    expect(args).toContain(CHROMA);
    expect(args).toContain('-bordercolor');
    expect(args).toContain(BORDER);
    expect(args).toContain(`${inner}x${inner}`);
    expect(args).toContain('-border');
    expect(args).toContain(String(geom.border));
  });

  test('resets gravity inside each cell group so the composite stays top-left', () => {
    const args = montageArgs(placements, geom, 'out/activities.1.png');
    expect(args.filter((a) => a === '+gravity')).toHaveLength(2);
    const geometryIdx = args.map((a, i) => (a === '-geometry' ? i : -1)).filter((i) => i >= 0);
    const allTopLeft = geometryIdx.every((i) => args[i - 1] === ')' && args[i - 2] === '+gravity');
    expect(allTopLeft).toBe(true);
  });

  test('composites each placement at its grid origin', () => {
    const args = montageArgs(placements, geom, 'out/activities.1.png');
    const origin0 = cellOrigin(0, geom);
    const origin5 = cellOrigin(5, geom);
    expect(args).toContain(`+${origin0.x}+${origin0.y}`);
    expect(args).toContain(`+${origin5.x}+${origin5.y}`);
    expect(args.filter((a) => a === '-composite')).toHaveLength(2);
    expect(args.filter((a) => a === '(')).toHaveLength(2);
    expect(args.filter((a) => a === ')')).toHaveLength(2);
  });

  test('an empty placement list yields just the CHROMA canvas and output', () => {
    const args = montageArgs([], geom, 'out/empty.1.png');
    expect(args).not.toContain('-composite');
    expect(args.at(-1)).toBe('out/empty.1.png');
  });

  test('a fileless cell becomes a bare CHROMA tile carrying only the BORDER', () => {
    const inner = geom.cell - 2 * geom.border;
    const args = montageArgs([{ index: 7 }], geom, 'out/partial.1.png');
    // The empty tile builds its own inner CHROMA canvas and frames it; no sprite
    // processing (no file read, alpha flatten, or fit/extent) happens.
    expect(args).not.toContain('-alpha');
    expect(args).not.toContain('-resize');
    expect(args).not.toContain('-extent');
    expect(args).toContain('-bordercolor');
    expect(args).toContain(BORDER);
    expect(args).toContain('-border');
    expect(args.filter((a) => a === `xc:${CHROMA}`)).toHaveLength(2); // sheet + tile
    expect(args.filter((a) => a === `${inner}x${inner}`)).toHaveLength(1); // tile -size
    const origin = cellOrigin(7, geom);
    expect(args).toContain(`+${origin.x}+${origin.y}`);
    expect(args.filter((a) => a === '-composite')).toHaveLength(1);
  });

  test('mixed filled + empty cells composite both, sprite framed and tiles bordered', () => {
    const args = montageArgs([{ index: 0, file: 'gen/kontext/hi.0.png' }, { index: 1 }], geom, 'out/mixed.1.png');
    expect(args.filter((a) => a === '-composite')).toHaveLength(2);
    expect(args.filter((a) => a === '(')).toHaveLength(2);
    expect(args).toContain('gen/kontext/hi.0.png'); // filled sprite
    expect(args).toContain('-alpha'); // only the filled cell flattens alpha
    expect(args.filter((a) => a === '-bordercolor')).toHaveLength(2); // both tiles framed
  });
});
