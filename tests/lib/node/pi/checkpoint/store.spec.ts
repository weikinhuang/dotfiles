/**
 * Tests for lib/node/pi/checkpoint/store.ts.
 *
 * Uses a tmpdir as the store dir so we exercise real fs paths. Pins
 * content-addressed dedup, blob round-trip, manifest read/write + index
 * rebuild, the project-key shape, and retention prune + blob GC.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  deriveProjectKey,
  fileSize,
  getBlobText,
  hasBlob,
  hashBytes,
  listManifests,
  pruneOldManifests,
  putBlob,
  readManifest,
  writeManifest,
} from '../../../../../lib/node/pi/checkpoint/store.ts';
import type { CheckpointManifest } from '../../../../../lib/node/pi/checkpoint/types.ts';

let store: string;

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'checkpoint-store-'));
});

afterEach(() => {
  rmSync(store, { recursive: true, force: true });
});

function manifest(leafEntryId: string, timestamp: number, blobs: string[]): CheckpointManifest {
  return {
    leafEntryId,
    timestamp,
    entries: blobs.map((sha, i) => ({
      path: `f${i}.ts`,
      before: null,
      after: sha,
      tool: 'write',
      toolCallId: `t${i}`,
    })),
  };
}

describe('hashBytes + blobs', () => {
  test('hashBytes is the sha256 hex and stable', () => {
    expect(hashBytes('abc')).toBe(hashBytes(Buffer.from('abc')));
    expect(hashBytes('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('putBlob is content-addressed and dedups', () => {
    const sha1 = putBlob(store, 'hello');
    const sha2 = putBlob(store, 'hello');
    expect(sha1).toBe(sha2);
    expect(hasBlob(store, sha1)).toBe(true);
    expect(getBlobText(store, sha1)).toBe('hello');
    // Only one blob file on disk despite two puts.
    expect(readdirSync(join(store, 'blobs'))).toHaveLength(1);
  });

  test('getBlobText returns undefined for a missing blob', () => {
    expect(getBlobText(store, 'deadbeef')).toBeUndefined();
  });
});

describe('manifests', () => {
  test('write then read round-trips', () => {
    const m = manifest('entry-1', 123, [putBlob(store, 'x')]);
    writeManifest(store, m);
    expect(readManifest(store, 'entry-1')).toEqual(m);
  });

  test('listManifests rebuilds the index, skipping malformed files', () => {
    writeManifest(store, manifest('e1', 1, []));
    writeManifest(store, manifest('e2', 2, []));
    writeFileSync(join(store, 'broken.json'), '{ not json');
    const ids = listManifests(store)
      .map((m) => m.leafEntryId)
      .sort();
    expect(ids).toEqual(['e1', 'e2']);
  });

  test('listManifests on a missing dir is empty', () => {
    expect(listManifests(join(store, 'nope'))).toEqual([]);
  });
});

describe('deriveProjectKey', () => {
  test('is <basename>-<12 hex> and stable for a path', () => {
    const key = deriveProjectKey('/home/u/source/dotfiles');
    expect(key).toMatch(/^dotfiles-[0-9a-f]{12}$/);
    expect(deriveProjectKey('/home/u/source/dotfiles')).toBe(key);
  });

  test('same basename, different path → different key', () => {
    expect(deriveProjectKey('/a/proj')).not.toBe(deriveProjectKey('/b/proj'));
  });
});

describe('pruneOldManifests', () => {
  test('retentionDays 0 keeps everything', () => {
    writeManifest(store, manifest('old', 0, []));
    expect(pruneOldManifests(store, 0, 1e12)).toEqual({ prunedManifests: [], prunedBlobs: [] });
    expect(readManifest(store, 'old')).toBeDefined();
  });

  test('prunes manifests older than the cutoff and GCs their blobs', () => {
    const now = 100 * 24 * 60 * 60 * 1000; // day 100
    const dayMs = 24 * 60 * 60 * 1000;
    const oldBlob = putBlob(store, 'old-content');
    const keepBlob = putBlob(store, 'keep-content');
    writeManifest(store, manifest('old', now - 40 * dayMs, [oldBlob])); // 40 days old
    writeManifest(store, manifest('fresh', now - 5 * dayMs, [keepBlob])); // 5 days old

    const result = pruneOldManifests(store, 30, now);
    expect(result.prunedManifests).toEqual(['old']);
    expect(result.prunedBlobs).toEqual([oldBlob]);
    expect(readManifest(store, 'old')).toBeUndefined();
    expect(readManifest(store, 'fresh')).toBeDefined();
    expect(hasBlob(store, keepBlob)).toBe(true);
    expect(hasBlob(store, oldBlob)).toBe(false);
  });

  test('a blob still referenced by a survivor is not GCd', () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const dayMs = 24 * 60 * 60 * 1000;
    const shared = putBlob(store, 'shared');
    writeManifest(store, manifest('old', now - 40 * dayMs, [shared]));
    writeManifest(store, manifest('fresh', now - 1 * dayMs, [shared]));
    const result = pruneOldManifests(store, 30, now);
    expect(result.prunedManifests).toEqual(['old']);
    expect(result.prunedBlobs).toEqual([]);
    expect(hasBlob(store, shared)).toBe(true);
  });
});

describe('fileSize', () => {
  test('returns byte size or undefined', () => {
    const p = join(store, 'sized.txt');
    writeFileSync(p, 'hello'); // 5 bytes
    expect(fileSize(p)).toBe(5);
    expect(fileSize(join(store, 'missing'))).toBeUndefined();
  });
});
