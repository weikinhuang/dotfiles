/**
 * Tests for lib/node/pi/avatar/png-decode.ts.
 */

import { deflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import { decodePng } from '../../../../../lib/node/pi/avatar/png-decode.ts';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Wrap chunk `data` with length + type + a zeroed CRC (the decoder ignores CRC). */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

function ihdr(width: number, height: number, colorType: number, bitDepth = 8, interlace = 0): Uint8Array {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  d[8] = bitDepth;
  d[9] = colorType;
  d[12] = interlace;
  return d;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface PngParts {
  ihdr: Uint8Array;
  raw: number[];
  plte?: number[];
  trns?: number[];
}

function buildPng(parts: PngParts): Uint8Array {
  const chunks: Uint8Array[] = [Uint8Array.from(SIGNATURE), chunk('IHDR', parts.ihdr)];
  if (parts.plte) chunks.push(chunk('PLTE', Uint8Array.from(parts.plte)));
  if (parts.trns) chunks.push(chunk('tRNS', Uint8Array.from(parts.trns)));
  chunks.push(chunk('IDAT', deflateSync(Uint8Array.from(parts.raw))));
  chunks.push(chunk('IEND', new Uint8Array(0)));
  return concat(chunks);
}

describe('decodePng', () => {
  test('decodes 8-bit RGBA with filter 0, preserving transparency', () => {
    // 2x2: red, green / blue, transparent-with-rgb
    const raw = [0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 10, 20, 30, 0];
    const out = decodePng(buildPng({ ihdr: ihdr(2, 2, 6), raw }));
    expect(out).not.toBeNull();
    expect(out?.width).toBe(2);
    expect(out?.height).toBe(2);
    expect(Array.from(out!.rgba)).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 0]);
  });

  test('reverses the Up filter on RGB scanlines', () => {
    // row0 (filter 0): (10,20,30); row1 (filter 2 = Up): stored delta (5,5,5) => (15,25,35)
    const raw = [0, 10, 20, 30, 2, 5, 5, 5];
    const out = decodePng(buildPng({ ihdr: ihdr(1, 2, 2), raw }));
    expect(Array.from(out!.rgba)).toEqual([10, 20, 30, 255, 15, 25, 35, 255]);
  });

  test('expands a palette image with tRNS alpha', () => {
    const out = decodePng(buildPng({ ihdr: ihdr(2, 1, 3), raw: [0, 0, 1], plte: [255, 0, 0, 0, 255, 0], trns: [128] }));
    expect(Array.from(out!.rgba)).toEqual([255, 0, 0, 128, 0, 255, 0, 255]);
  });

  test('returns null for unsupported bit depth and interlacing', () => {
    expect(decodePng(buildPng({ ihdr: ihdr(1, 1, 6, 16), raw: [0, 0, 0, 0, 0, 0, 0, 0] }))).toBeNull();
    expect(decodePng(buildPng({ ihdr: ihdr(1, 1, 6, 8, 1), raw: [0, 0, 0, 0, 0] }))).toBeNull();
  });

  test('returns null for a non-PNG buffer', () => {
    expect(decodePng(new Uint8Array(8))).toBeNull();
  });
});
