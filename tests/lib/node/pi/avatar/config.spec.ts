/**
 * Tests for lib/node/pi/avatar/config.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  coerceConfigLayer,
  DEFAULT_CONFIG,
  mergeConfigLayers,
  mergeEmoteMappings,
} from '../../../../../lib/node/pi/avatar/config.ts';

describe('coerceConfigLayer', () => {
  test('keeps well-typed fields and drops wrong-typed ones', () => {
    const out = coerceConfigLayer({
      enabled: false,
      size: 12,
      render: 'kitty',
      talkTickMs: 'nope',
      blinkInterval: [1000, 2000],
    });
    expect(out).toEqual({ enabled: false, size: 12, render: 'kitty', blinkInterval: [1000, 2000] });
  });

  test('coerces the compact boolean and drops a non-boolean', () => {
    expect(coerceConfigLayer({ compact: false }).compact).toBe(false);
    expect(coerceConfigLayer({ compact: 'yes' }).compact).toBeUndefined();
  });

  test('swaps a reversed blinkInterval so the min comes first', () => {
    // A reversed pair would make randomInRange sample backwards; normalize it.
    expect(coerceConfigLayer({ blinkInterval: [6000, 3000] }).blinkInterval).toEqual([3000, 6000]);
    expect(coerceConfigLayer({ blinkInterval: [3000, 6000] }).blinkInterval).toEqual([3000, 6000]);
  });

  test('rejects malformed blinkInterval and bad render values', () => {
    expect(coerceConfigLayer({ blinkInterval: [1000] }).blinkInterval).toBeUndefined();
    expect(coerceConfigLayer({ blinkInterval: ['a', 'b'] }).blinkInterval).toBeUndefined();
    expect(coerceConfigLayer({ render: 'jpeg' }).render).toBeUndefined();
    expect(coerceConfigLayer({ render: 'sixel' }).render).toBe('sixel');
    expect(coerceConfigLayer({ render: 'halfblock' }).render).toBe('halfblock');
  });

  test('keeps a valid scenePlacement and drops an unknown one', () => {
    expect(coerceConfigLayer({ scenePlacement: 'below' }).scenePlacement).toBe('below');
    expect(coerceConfigLayer({ scenePlacement: 'replace' }).scenePlacement).toBe('replace');
    expect(coerceConfigLayer({ scenePlacement: 'sideways' }).scenePlacement).toBeUndefined();
  });

  test('floors sceneMaxRows to an integer >= 1 and drops a non-number', () => {
    expect(coerceConfigLayer({ sceneMaxRows: 8.7 }).sceneMaxRows).toBe(8);
    expect(coerceConfigLayer({ sceneMaxRows: 0 }).sceneMaxRows).toBe(1);
    expect(coerceConfigLayer({ sceneMaxRows: 'tall' }).sceneMaxRows).toBeUndefined();
  });

  test('merges partial holdDuration over defaults', () => {
    const out = coerceConfigLayer({ holdDuration: { hi: 5000 } });
    expect(out.holdDuration).toEqual({ hi: 5000, success: 1200, failure: 1200 });
  });

  test('filters emote mappings to valid entries only', () => {
    const out = coerceConfigLayer({
      emotes: [{ model: '*', 'emote-set': 'default' }, { model: 5 }, { 'emote-set': 'x' }],
    });
    expect(out.emotes).toEqual([{ model: '*', 'emote-set': 'default' }]);
  });

  test('parses overlays as a string array, dropping non-strings', () => {
    const out = coerceConfigLayer({
      emotes: [{ model: '*', 'emote-set': 'exusiai', overlays: ['mature', 7, 'extra'] }],
    });
    expect(out.emotes).toEqual([{ model: '*', 'emote-set': 'exusiai', overlays: ['mature', 'extra'] }]);
  });

  test('omits overlays when absent or empty', () => {
    const out = coerceConfigLayer({
      emotes: [
        { model: '*', 'emote-set': 'default' },
        { model: '*claude*', 'emote-set': 'robot', overlays: [] },
      ],
    });
    expect(out.emotes).toEqual([
      { model: '*', 'emote-set': 'default' },
      { model: '*claude*', 'emote-set': 'robot' },
    ]);
  });

  test('non-object input yields an empty layer', () => {
    expect(coerceConfigLayer(null)).toEqual({});
    expect(coerceConfigLayer('str')).toEqual({});
    expect(coerceConfigLayer([1, 2])).toEqual({});
  });
});

describe('mergeEmoteMappings', () => {
  test('appends layers in priority order', () => {
    const out = mergeEmoteMappings(
      [{ model: '*', 'emote-set': 'default' }],
      [{ model: '*claude*', 'emote-set': 'robot' }],
    );
    expect(out).toEqual([
      { model: '*', 'emote-set': 'default' },
      { model: '*claude*', 'emote-set': 'robot' },
    ]);
  });

  test('skips empty / undefined layers and falls back to default', () => {
    expect(mergeEmoteMappings(undefined, [])).toEqual(DEFAULT_CONFIG.emotes);
  });
});

describe('mergeConfigLayers', () => {
  test('with no layers returns a copy of the defaults', () => {
    const out = mergeConfigLayers();
    expect(out).toEqual(DEFAULT_CONFIG);
    expect(out.holdDuration).not.toBe(DEFAULT_CONFIG.holdDuration);
    expect(out.emotes).not.toBe(DEFAULT_CONFIG.emotes);
  });

  test('higher-priority scalar layers override lower ones', () => {
    const out = mergeConfigLayers({ size: 10 }, { size: 16, render: 'ascii' });
    expect(out.size).toBe(16);
    expect(out.render).toBe('ascii');
  });

  test('scene placement + max rows override across layers (default above/12)', () => {
    expect(mergeConfigLayers().scenePlacement).toBe('above');
    expect(mergeConfigLayers().sceneMaxRows).toBe(12);
    const out = mergeConfigLayers({ scenePlacement: 'below' }, { scenePlacement: 'replace', sceneMaxRows: 6 });
    expect(out.scenePlacement).toBe('replace');
    expect(out.sceneMaxRows).toBe(6);
  });

  test('holdDuration merges field-wise across layers', () => {
    const out = mergeConfigLayers(
      { holdDuration: { hi: 1, success: 2, failure: 3 } },
      { holdDuration: { hi: 9, success: 2, failure: 3 } },
    );
    expect(out.holdDuration).toEqual({ hi: 9, success: 2, failure: 3 });
  });

  test('emotes append after the default catch-all (last match wins downstream)', () => {
    const out = mergeConfigLayers({ emotes: [{ model: '*claude*', 'emote-set': 'robot' }] });
    expect(out.emotes).toEqual([
      { model: '*', 'emote-set': 'default' },
      { model: '*claude*', 'emote-set': 'robot' },
    ]);
  });
});
