/**
 * Per-set, per-width sixel frame cache for the `avatar` extension.
 *
 * Building a sixel frame (PNG decode + nearest-neighbour resize + sixel
 * encode) is the sole expensive path in the renderer. Sixel sequences are
 * memoised to a JSON file per set + width (`.sixel-cache-<dstW>[-tmux].json`)
 * so `/reload` and future sessions skip encoding entirely. One file per width
 * (`dstW`) keeps any single file bounded and lets a font/DPI change land in a
 * fresh file instead of bloating one forever.
 *
 * Pure module - `node:fs` only, no pi runtime - so the keying, load/merge, and
 * cache-hit behaviour are unit-testable against a temp directory.
 */

import { statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { atomicWriteFile } from '../atomic-write.ts';
import { readJsonOrUndefined } from '../fs-safe.ts';
import { type CellDimensions, buildImageFrame } from './render.ts';
import type { RenderedFrame } from './store.ts';
import type { Protocol } from './types.ts';

export interface SixelCacheEntry {
  seq: string;
  rows: number;
}

interface SixelCacheFile {
  v: number;
  cols: number;
  dstW: number;
  entries: Record<string, SixelCacheEntry>;
}

export class SixelCache {
  private readonly file: string;
  private readonly entries = new Map<string, SixelCacheEntry>();
  private dirty = false;
  constructor(
    private readonly setDir: string,
    private readonly cols: number,
    private readonly dstW: number,
    variant: string,
  ) {
    this.file = join(setDir, `.sixel-cache-${dstW}${variant}.json`);
    const data = readJsonOrUndefined<SixelCacheFile>(this.file);
    if (data?.dstW === dstW && data.entries) {
      for (const [k, v] of Object.entries(data.entries)) {
        if (v && typeof v.seq === 'string' && typeof v.rows === 'number') this.entries.set(k, v);
      }
    }
  }
  get size(): number {
    return this.entries.size;
  }
  /** Cache key for a PNG: path relative to the set dir + mtime + size. */
  private key(pngPath: string): string | null {
    try {
      const st = statSync(pngPath);
      return `${relative(this.setDir, pngPath)}:${Math.round(st.mtimeMs)}:${st.size}`;
    } catch {
      return null;
    }
  }
  lookup(pngPath: string): { key: string; entry: SixelCacheEntry | undefined } | null {
    const key = this.key(pngPath);
    if (key === null) return null;
    return { key, entry: this.entries.get(key) };
  }
  put(key: string, entry: SixelCacheEntry): void {
    this.entries.set(key, entry);
    this.dirty = true;
  }
  /** Merge our additions over whatever is on disk now, then write atomically. */
  flush(): void {
    if (!this.dirty) return;
    try {
      const onDisk = readJsonOrUndefined<SixelCacheFile>(this.file);
      const merged: Record<string, SixelCacheEntry> =
        onDisk && onDisk.dstW === this.dstW && onDisk.entries ? { ...onDisk.entries } : {};
      for (const [k, v] of this.entries) merged[k] = v;
      const out: SixelCacheFile = { v: 1, cols: this.cols, dstW: this.dstW, entries: merged };
      atomicWriteFile(this.file, JSON.stringify(out));
      this.dirty = false;
    } catch {
      /* cache is best-effort; never break the session */
    }
  }
}

/**
 * Build a frame for `pngPath`, serving the sixel sequence from `cache` on a hit
 * (skips read + decode + encode entirely). Misses fall through to
 * {@link buildImageFrame} and populate the cache.
 */
export function buildFrameCached(
  pngPath: string,
  protocol: Protocol,
  cols: number,
  cell: CellDimensions,
  cache: SixelCache | null,
): RenderedFrame | null {
  if (protocol === 'sixel' && cache) {
    const looked = cache.lookup(pngPath);
    if (looked) {
      if (looked.entry) {
        return { kind: 'image', sequence: looked.entry.seq, rows: looked.entry.rows, style: 'sixel' };
      }
      const frame = buildImageFrame(pngPath, protocol, cols, cell);
      if (frame?.kind === 'image' && frame.style === 'sixel') {
        cache.put(looked.key, { seq: frame.sequence, rows: frame.rows });
      }
      return frame;
    }
  }
  return buildImageFrame(pngPath, protocol, cols, cell);
}
