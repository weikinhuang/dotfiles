/**
 * Tests for lib/node/pi/avatar/cache.ts.
 */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import { SixelCache, buildFrameCached } from '../../../../../lib/node/pi/avatar/cache.ts';

const CELL = { widthPx: 8, heightPx: 16 };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'avatar-cache-'));
}

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

/** Write a small valid 2x2 RGBA PNG to `path`. */
function writePng(path: string): void {
  const header = new Uint8Array(13);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, 2);
  dv.setUint32(4, 2);
  header[8] = 8;
  header[9] = 6;
  const raw = [0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 10, 20, 30, 0];
  const png = concat([
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Uint8Array.from(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]);
  writeFileSync(path, png);
}

describe('SixelCache lookup / key', () => {
  test('returns null for a nonexistent path', () => {
    const cache = new SixelCache(tmp(), 4, 32, '');
    expect(cache.lookup('/no/such/file.png')).toBeNull();
  });

  test('reports a miss (entry undefined) for an unseen but existing file', () => {
    const dir = tmp();
    const png = join(dir, 'a.png');
    writeFileSync(png, 'x');
    const cache = new SixelCache(dir, 4, 32, '');
    const looked = cache.lookup(png);
    expect(looked).not.toBeNull();
    expect(looked?.entry).toBeUndefined();
    expect(typeof looked?.key).toBe('string');
  });

  test('put makes a subsequent lookup hit under the same key', () => {
    const dir = tmp();
    const png = join(dir, 'a.png');
    writeFileSync(png, 'x');
    const cache = new SixelCache(dir, 4, 32, '');
    const key = cache.lookup(png)?.key ?? '';
    cache.put(key, { seq: 'SEQ', rows: 2 });
    expect(cache.lookup(png)?.entry).toEqual({ seq: 'SEQ', rows: 2 });
    expect(cache.size).toBe(1);
  });
});

describe('SixelCache flush / load', () => {
  test('flush is a no-op when nothing was put (no file written)', () => {
    const dir = tmp();
    const file = join(dir, '.sixel-cache-32.json');
    new SixelCache(dir, 4, 32, '').flush();
    expect(existsSync(file)).toBe(false);
  });

  test('flushed entries reload in a fresh cache with the same dstW', () => {
    const dir = tmp();
    const png = join(dir, 'a.png');
    writeFileSync(png, 'x');
    const first = new SixelCache(dir, 4, 32, '');
    const key = first.lookup(png)?.key ?? '';
    first.put(key, { seq: 'SEQ', rows: 3 });
    first.flush();

    const second = new SixelCache(dir, 4, 32, '');
    expect(second.size).toBe(1);
    expect(second.lookup(png)?.entry).toEqual({ seq: 'SEQ', rows: 3 });
  });

  test('a cache file for a different dstW is ignored on load', () => {
    const dir = tmp();
    const png = join(dir, 'a.png');
    writeFileSync(png, 'x');
    const first = new SixelCache(dir, 4, 32, '');
    first.put(first.lookup(png)?.key ?? '', { seq: 'SEQ', rows: 3 });
    first.flush();

    // Same file name is keyed by dstW; a cache opened at a different dstW
    // writes/reads a different file, so this one starts empty.
    const other = new SixelCache(dir, 4, 64, '');
    expect(other.size).toBe(0);
  });

  test('the variant suffix segregates tmux from non-tmux cache files', () => {
    const dir = tmp();
    const png = join(dir, 'a.png');
    writeFileSync(png, 'x');
    const plain = new SixelCache(dir, 4, 32, '');
    plain.put(plain.lookup(png)?.key ?? '', { seq: 'PLAIN', rows: 1 });
    plain.flush();

    const tmux = new SixelCache(dir, 4, 32, '-tmux');
    expect(tmux.size).toBe(0);
  });
});

describe('buildFrameCached', () => {
  test('serves a cached sixel entry without decoding (hit short-circuits)', () => {
    const dir = tmp();
    const png = join(dir, 'a.png');
    writeFileSync(png, 'not a real png');
    const cache = new SixelCache(dir, 4, 32, '');
    cache.put(cache.lookup(png)?.key ?? '', { seq: 'CACHED', rows: 5 });

    expect(buildFrameCached(png, 'sixel', 4, CELL, cache)).toEqual({
      kind: 'image',
      sequence: 'CACHED',
      rows: 5,
      style: 'sixel',
    });
  });

  test('a sixel miss builds the frame and populates the cache', () => {
    const dir = tmp();
    const png = join(dir, 'a.png');
    writePng(png);
    const cache = new SixelCache(dir, 4, 32, '');
    expect(cache.size).toBe(0);

    const frame = buildFrameCached(png, 'sixel', 4, CELL, cache);
    expect(frame?.kind).toBe('image');
    expect(cache.size).toBe(1);
    // A second call now hits the populated cache.
    expect(buildFrameCached(png, 'sixel', 4, CELL, cache)).toEqual(frame);
  });

  test('non-sixel protocols bypass the cache entirely', () => {
    const dir = tmp();
    const png = join(dir, 'a.png');
    writePng(png);
    const cache = new SixelCache(dir, 4, 32, '');
    const frame = buildFrameCached(png, 'kitty', 4, CELL, cache);
    expect(frame?.kind).toBe('image');
    expect(cache.size).toBe(0);
  });

  test('returns null for an unreadable file with no cache', () => {
    expect(buildFrameCached('/no/such/file.png', 'sixel', 4, CELL, null)).toBeNull();
  });
});
