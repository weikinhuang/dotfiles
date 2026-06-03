/**
 * Tests for lib/node/pi/image-ref/config.ts (pure coerce + merge only;
 * the disk-reading loadImageRefConfig is exercised via the extension).
 */

import { describe, expect, test } from 'vitest';

import { coerceConfigLayer, DEFAULT_CONFIG, mergeConfigLayers } from '../../../../../lib/node/pi/image-ref/config.ts';

describe('coerceConfigLayer', () => {
  test('keeps valid fields, drops invalid ones', () => {
    expect(coerceConfigLayer({ maxImages: 3, autoResize: false, maxFileBytes: 1024 })).toEqual({
      maxImages: 3,
      autoResize: false,
      maxFileBytes: 1024,
    });
  });

  test('rejects non-positive / non-integer / wrong-type values', () => {
    expect(coerceConfigLayer({ maxImages: 0 })).toEqual({});
    expect(coerceConfigLayer({ maxImages: 2.5 })).toEqual({});
    expect(coerceConfigLayer({ autoResize: 'yes' })).toEqual({});
    expect(coerceConfigLayer({ maxFileBytes: -1 })).toEqual({});
  });

  test('returns an empty layer for non-objects', () => {
    expect(coerceConfigLayer(null)).toEqual({});
    expect(coerceConfigLayer([1, 2])).toEqual({});
    expect(coerceConfigLayer('nope')).toEqual({});
  });
});

describe('mergeConfigLayers', () => {
  test('defaults apply when no layers contribute', () => {
    expect(mergeConfigLayers()).toEqual(DEFAULT_CONFIG);
  });

  test('later layers win over earlier ones', () => {
    const merged = mergeConfigLayers({ maxImages: 4 }, { maxImages: 9, autoResize: false });
    expect(merged.maxImages).toBe(9);
    expect(merged.autoResize).toBe(false);
    expect(merged.maxFileBytes).toBe(DEFAULT_CONFIG.maxFileBytes);
  });
});
