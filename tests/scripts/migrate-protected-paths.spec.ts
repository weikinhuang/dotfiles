/**
 * Unit tests for `scripts/migrate-protected-paths.ts` - the throwaway
 * one-shot migrator from the legacy `~/.pi/protected-paths.json`
 * schema to the unified `~/.pi/filesystem.json`.
 *
 * Only the pure translator (`translateLegacyConfig`) is tested here -
 * the file-IO main() is covered by the README in the script itself
 * and by the manual smoke procedure in plan section 11.
 */

import { describe, expect, test } from 'vitest';

import { translateLegacyConfig } from '../../scripts/migrate-protected-paths.ts';

describe('translateLegacyConfig', () => {
  test('lifts read.* into read.deny.* and write.* into write.deny.*', () => {
    const out = translateLegacyConfig({
      read: { basenames: ['.env', '.env.*'], paths: ['~/.ssh'] },
      write: { segments: ['node_modules', '.git'] },
    });
    expect(out.read.deny.basenames).toEqual(['.env', '.env.*']);
    expect(out.read.deny.paths).toEqual(['~/.ssh']);
    expect(out.read.deny.segments).toEqual([]);
    expect(out.write.deny.segments).toEqual(['node_modules', '.git']);
    expect(out.write.deny.basenames).toEqual([]);
    expect(out.write.deny.paths).toEqual([]);
  });

  test('seeds write.allow.paths with the new allow-only defaults', () => {
    const out = translateLegacyConfig({});
    expect(out.write.allow.paths).toEqual(['.', '/tmp']);
    expect(out.write.allow.basenames).toEqual([]);
    expect(out.write.allow.segments).toEqual([]);
  });

  test('read.allow stays empty (legacy schema had no allow-back)', () => {
    const out = translateLegacyConfig({
      read: { basenames: ['.env'] },
    });
    expect(out.read.allow.basenames).toEqual([]);
    expect(out.read.allow.segments).toEqual([]);
    expect(out.read.allow.paths).toEqual([]);
  });

  test('coerces away non-string array entries (legacy files in the wild)', () => {
    const out = translateLegacyConfig({
      read: { basenames: ['.env', 42 as unknown as string, null as unknown as string, '.envrc'] },
    });
    expect(out.read.deny.basenames).toEqual(['.env', '.envrc']);
  });

  test('missing top-level keys produce empty buckets', () => {
    const out = translateLegacyConfig({});
    expect(out.read.deny.basenames).toEqual([]);
    expect(out.write.deny.basenames).toEqual([]);
  });

  test('non-array fields are dropped without crashing', () => {
    const out = translateLegacyConfig({
      read: { basenames: 'oops' as unknown as string[] },
    });
    expect(out.read.deny.basenames).toEqual([]);
  });
});
