/**
 * Tests for config/pi/avatar/tools/manifest-loader.ts: the `--manifest` external
 * load path that lets a device-local character manifest drive the prompt/slice
 * tools without touching the committed, character-agnostic manifest.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { isContentManifest, loadManifest } from '../../../../../config/pi/avatar/tools/manifest-loader.ts';
import { manifest as committed } from '../../../../../config/pi/avatar/tools/sprite-manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => join(here, 'fixtures', name);

describe('loadManifest', () => {
  test('with no path returns the committed manifest', async () => {
    const m = await loadManifest();
    expect(m).toBe(committed);
    expect(m.allSheets().length).toBeGreaterThan(0);
  });

  test('with an empty path returns the committed manifest', async () => {
    expect(await loadManifest('')).toBe(committed);
  });

  test('loads an external manifest module by path', async () => {
    const m = await loadManifest(fixture('mini-manifest.ts'));
    expect(m.TIERS).toEqual(['demo']);
    expect(m.ALL_STATES).toEqual(['wave', 'nod']);
    const sheets = m.allSheets();
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe('demo.1');
    // 2 states x 2 frames (base + default beat) = 4 non-null cells.
    expect(sheets[0].cells.filter((c) => c !== null)).toHaveLength(4);
  });

  test('rejects a module whose `manifest` export is not a ContentManifest', async () => {
    await expect(loadManifest(fixture('not-a-manifest.ts'))).rejects.toThrow(/must export a `manifest`/);
  });
});

describe('isContentManifest', () => {
  test('accepts the committed manifest', () => {
    expect(isContentManifest(committed)).toBe(true);
  });

  test('rejects non-objects and incomplete shapes', () => {
    expect(isContentManifest(null)).toBe(false);
    expect(isContentManifest(undefined)).toBe(false);
    expect(isContentManifest({})).toBe(false);
    expect(isContentManifest({ allSheets: (): [] => [] })).toBe(false);
  });
});
