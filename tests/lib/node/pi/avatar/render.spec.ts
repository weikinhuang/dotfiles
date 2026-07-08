/**
 * Tests for lib/node/pi/avatar/render.ts.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import {
  type TextMeasure,
  buildImageFrame,
  imageRows,
  renderHalfblockFrame,
  renderITermFrame,
  renderKittyFrame,
  renderSceneBanner,
  renderSixelFrame,
  renderTextFrame,
  renderTextFrameCompact,
} from '../../../../../lib/node/pi/avatar/render.ts';
import { SIXEL_IMAGE_LINE_MARKER } from '../../../../../lib/node/pi/avatar/sixel.ts';
import type { RenderedFrame } from '../../../../../lib/node/pi/avatar/store.ts';

// A length-based measure so line math is exactly predictable in assertions.
const measure: TextMeasure = {
  visibleWidth: (text) => text.length,
  truncateToWidth: (text, width, ellipsis) =>
    text.length > width ? text.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis : text,
};

type ImageFrame = Extract<RenderedFrame, { kind: 'image' }>;

const imageFrame = (style: 'kitty' | 'iterm2' | 'sixel', sequence: string, rows: number): ImageFrame => ({
  kind: 'image',
  sequence,
  rows,
  style,
});

const imageStyle = (frame: RenderedFrame | null): string | null => (frame?.kind === 'image' ? frame.style : null);

const imageSequence = (frame: RenderedFrame | null): string => (frame?.kind === 'image' ? frame.sequence : '');

// ── PNG fixture (mirrors tests/.../png-decode.spec.ts) ───────────────────
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

function ihdr(width: number, height: number, colorType: number): Uint8Array {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  d[8] = 8;
  d[9] = colorType;
  return d;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A 2x2 RGBA PNG (red, green / blue, transparent). */
function samplePng(): Uint8Array {
  const raw = [0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 10, 20, 30, 0];
  return concat([
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', ihdr(2, 2, 6)),
    chunk('IDAT', deflateSync(Uint8Array.from(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function writeSamplePng(): string {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-render-'));
  const path = join(dir, 'sprite.png');
  writeFileSync(path, samplePng());
  return path;
}

describe('imageRows', () => {
  test('scales height to the cell grid preserving aspect', () => {
    // 100x50 image, 10 cols, 8x16 px cells -> width 80px -> height 40px -> 2.5 -> 3 rows.
    expect(imageRows({ width: 100, height: 50 }, 10, { widthPx: 8, heightPx: 16 })).toBe(3);
  });

  test('never returns less than one row', () => {
    expect(imageRows({ width: 1000, height: 1 }, 2, { widthPx: 8, heightPx: 16 })).toBe(1);
  });

  test('falls back to cols/2 for a degenerate width or cell height', () => {
    expect(imageRows({ width: 0, height: 10 }, 8, { widthPx: 8, heightPx: 16 })).toBe(4);
    expect(imageRows({ width: 10, height: 10 }, 8, { widthPx: 8, heightPx: 0 })).toBe(4);
  });
});

describe('renderKittyFrame', () => {
  test('emits the sequence only on the first row', () => {
    const lines = renderKittyFrame(imageFrame('kitty', 'IMG', 2), 2, ['x', 'y'], 'S');
    expect(lines).toEqual([' IMG   S x', '    S y']);
  });
});

describe('renderITermFrame', () => {
  test('puts the escape on the last row with a cursor-up prefix', () => {
    const lines = renderITermFrame(imageFrame('iterm2', 'IMG', 2), 2, ['x', 'y'], 'S');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('\x1b[3C S x');
    expect(lines[1]).toBe('\x1b[1A\x1b[1CIMG S y');
  });
});

describe('renderSixelFrame', () => {
  test('paints the sixel on the last line inside DECSC/DECRC', () => {
    const lines = renderSixelFrame(imageFrame('sixel', 'PIX', 2), 2, ['x', 'y'], 'S');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('\x1b[3C S x');
    expect(lines[1]).toContain('\x1b7');
    expect(lines[1]).toContain('PIX');
    expect(lines[1]).toContain('\x1b8');
  });
});

describe('renderHalfblockFrame', () => {
  test('lays each cell row beside the info column', () => {
    const frame: RenderedFrame = { kind: 'halfblock', cells: ['AA', 'BB'], rows: 2 };
    expect(renderHalfblockFrame(frame, 2, ['x', 'y'], 'S')).toEqual([' AA S x', ' BB S y']);
  });
});

describe('renderSceneBanner', () => {
  test('text scene indents each line', () => {
    const frame: RenderedFrame = { kind: 'text', lines: ['l1', 'l2'] };
    expect(renderSceneBanner(frame, 10)).toEqual([' l1', ' l2']);
  });

  test('halfblock scene indents each cell row', () => {
    const frame: RenderedFrame = { kind: 'halfblock', cells: ['AA', 'BB'], rows: 2 };
    expect(renderSceneBanner(frame, 10)).toEqual([' AA', ' BB']);
  });

  test('kitty scene reserves rows with the escape on row 0', () => {
    const lines = renderSceneBanner(imageFrame('kitty', 'IMG', 2), 3);
    expect(lines).toEqual([' IMG   ', '    ']);
  });

  test('sixel scene paints on the last line', () => {
    const lines = renderSceneBanner(imageFrame('sixel', 'PIX', 2), 3);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(' ');
    expect(lines[1]).toContain('PIX');
  });
});

describe('renderTextFrameCompact', () => {
  test('centres the face and appends the tally', () => {
    const frame: RenderedFrame = { kind: 'text', lines: ['hi'] };
    expect(renderTextFrameCompact(frame, 4, 't', 'S', 20, measure)).toEqual(['  hi  S t']);
  });

  test('truncates a tally wider than the available width', () => {
    const frame: RenderedFrame = { kind: 'text', lines: ['hi'] };
    const [line] = renderTextFrameCompact(frame, 4, 'abcdef', 'S', 12, measure);
    // width-size-4 = 4 -> tally truncated to 4 incl the 1-char ellipsis.
    expect(line).toBe('  hi  S abc\u2026');
  });
});

describe('renderTextFrame', () => {
  test('reserves an emote row and pads to at least three rows', () => {
    const frame: RenderedFrame = { kind: 'text', lines: ['hi'] };
    const lines = renderTextFrame(frame, 4, ['a', 'b', 'c'], 'S', measure);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('hi');
    expect(lines[1]).toBe('  hi  S b');
  });
});

describe('buildImageFrame', () => {
  test('returns null for an unreadable path', () => {
    expect(buildImageFrame('/no/such/file.png', 'kitty', 4, { widthPx: 8, heightPx: 16 })).toBeNull();
  });

  test('builds a kitty image frame', () => {
    const frame = buildImageFrame(writeSamplePng(), 'kitty', 4, { widthPx: 8, heightPx: 16 });
    expect(frame?.kind).toBe('image');
    expect(imageStyle(frame)).toBe('kitty');
  });

  test('builds an iterm2 image frame', () => {
    const frame = buildImageFrame(writeSamplePng(), 'iterm2', 4, { widthPx: 8, heightPx: 16 });
    expect(imageStyle(frame)).toBe('iterm2');
  });

  test('builds a halfblock frame', () => {
    const frame = buildImageFrame(writeSamplePng(), 'halfblock', 4, { widthPx: 8, heightPx: 16 });
    expect(frame?.kind).toBe('halfblock');
  });

  test('builds a sixel frame prefixed with the image-line marker', () => {
    const frame = buildImageFrame(writeSamplePng(), 'sixel', 4, { widthPx: 8, heightPx: 16 });
    expect(frame?.kind).toBe('image');
    expect(imageStyle(frame)).toBe('sixel');
    expect(imageSequence(frame).startsWith(SIXEL_IMAGE_LINE_MARKER)).toBe(true);
  });

  test('wraps the sequence for tmux when the env says so', () => {
    const path = writeSamplePng();
    const bare = buildImageFrame(path, 'kitty', 4, { widthPx: 8, heightPx: 16 }, {});
    const wrapped = buildImageFrame(
      path,
      'kitty',
      4,
      { widthPx: 8, heightPx: 16 },
      { TMUX: '/tmp/tmux-1000/default,1,0' },
    );
    expect(imageSequence(bare).length).toBeGreaterThan(0);
    expect(imageSequence(wrapped)).not.toBe(imageSequence(bare));
  });
});
