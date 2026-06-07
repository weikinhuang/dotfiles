/**
 * Tests for lib/node/pi/roleplay/config.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  coerceConfigLayer,
  DEFAULT_CONFIG,
  loadRoleplayConfig,
  mergeConfigLayers,
  MAX_SCAN_DEPTH,
  MIN_CHAR_BUDGET,
  MIN_SUMMARY_CHARS,
} from '../../../../../lib/node/pi/roleplay/config.ts';

test('coerceConfigLayer accepts a valid charBudget and floors it', () => {
  expect(coerceConfigLayer({ charBudget: 5000 })).toEqual({ charBudget: 5000 });
  expect(coerceConfigLayer({ charBudget: 10 })).toEqual({ charBudget: MIN_CHAR_BUDGET });
  expect(coerceConfigLayer({ charBudget: 1234.9 })).toEqual({ charBudget: 1234 });
});

test('coerceConfigLayer ignores junk', () => {
  expect(coerceConfigLayer(null)).toEqual({});
  expect(coerceConfigLayer('nope')).toEqual({});
  expect(coerceConfigLayer({ charBudget: 'big' })).toEqual({});
  expect(coerceConfigLayer({ charBudget: Number.NaN })).toEqual({});
  expect(coerceConfigLayer({ unrelated: 1 })).toEqual({});
});

test('coerceConfigLayer accepts loreCharBudget + maxRecursion and clamps them', () => {
  expect(coerceConfigLayer({ loreCharBudget: 4000 })).toEqual({ loreCharBudget: 4000 });
  expect(coerceConfigLayer({ loreCharBudget: 10 })).toEqual({ loreCharBudget: MIN_CHAR_BUDGET });
  expect(coerceConfigLayer({ maxRecursion: 1 })).toEqual({ maxRecursion: 1 });
  expect(coerceConfigLayer({ maxRecursion: 99 })).toEqual({ maxRecursion: 2 }); // clamped to cap
  expect(coerceConfigLayer({ maxRecursion: -5 })).toEqual({ maxRecursion: 0 });
  expect(coerceConfigLayer({ maxRecursion: 1.9 })).toEqual({ maxRecursion: 1 });
});

test('coerceConfigLayer accepts scanDepth and clamps to [1, MAX_SCAN_DEPTH]', () => {
  expect(coerceConfigLayer({ scanDepth: 5 })).toEqual({ scanDepth: 5 });
  expect(coerceConfigLayer({ scanDepth: 0 })).toEqual({ scanDepth: 1 });
  expect(coerceConfigLayer({ scanDepth: 9999 })).toEqual({ scanDepth: MAX_SCAN_DEPTH });
  expect(coerceConfigLayer({ scanDepth: 7.8 })).toEqual({ scanDepth: 7 });
});

test('coerceConfigLayer accepts relationship decay knobs and clamps them', () => {
  expect(coerceConfigLayer({ relationshipDecayPerDay: 2.5 })).toEqual({ relationshipDecayPerDay: 2.5 });
  expect(coerceConfigLayer({ relationshipDecayPerDay: -3 })).toEqual({ relationshipDecayPerDay: 0 });
  expect(coerceConfigLayer({ relationshipBaseline: 40 })).toEqual({ relationshipBaseline: 40 });
  expect(coerceConfigLayer({ relationshipBaseline: 250 })).toEqual({ relationshipBaseline: 100 });
  expect(coerceConfigLayer({ relationshipBaseline: -9 })).toEqual({ relationshipBaseline: 0 });
  expect(coerceConfigLayer({ relationshipBaseline: 33.9 })).toEqual({ relationshipBaseline: 33 });
  expect(coerceConfigLayer({ relationshipDecayPerDay: 'x', relationshipBaseline: Number.NaN })).toEqual({});
});

test('coerceConfigLayer accepts summarize knobs and clamps them', () => {
  expect(coerceConfigLayer({ summarizeMinMessages: 8 })).toEqual({ summarizeMinMessages: 8 });
  expect(coerceConfigLayer({ summarizeMinMessages: 0 })).toEqual({ summarizeMinMessages: 1 });
  expect(coerceConfigLayer({ summarizeMinMessages: 6.7 })).toEqual({ summarizeMinMessages: 6 });
  expect(coerceConfigLayer({ summarizeMaxChars: 3000 })).toEqual({ summarizeMaxChars: 3000 });
  expect(coerceConfigLayer({ summarizeMaxChars: 10 })).toEqual({ summarizeMaxChars: MIN_SUMMARY_CHARS });
  expect(coerceConfigLayer({ summarizeMinMessages: 'x', summarizeMaxChars: Number.NaN })).toEqual({});
});

test('mergeConfigLayers applies later layers on top of defaults', () => {
  expect(mergeConfigLayers()).toEqual(DEFAULT_CONFIG);
  expect(mergeConfigLayers({ charBudget: 4000 })).toEqual({ ...DEFAULT_CONFIG, charBudget: 4000 });
  expect(mergeConfigLayers({ charBudget: 4000 }, { charBudget: 6000 })).toEqual({
    ...DEFAULT_CONFIG,
    charBudget: 6000,
  });
  expect(mergeConfigLayers({ loreCharBudget: 5000 }, { maxRecursion: 2 })).toEqual({
    ...DEFAULT_CONFIG,
    loreCharBudget: 5000,
    maxRecursion: 2,
  });
});

test('loadRoleplayConfig falls back to defaults with no files and applies env', () => {
  // No roleplay.json on disk for this cwd -> defaults (env layer empty).
  expect(loadRoleplayConfig('/nonexistent/cwd/for/test')).toEqual(DEFAULT_CONFIG);
  expect(loadRoleplayConfig('/nonexistent/cwd/for/test', 8000)).toEqual({ ...DEFAULT_CONFIG, charBudget: 8000 });
  expect(loadRoleplayConfig('/nonexistent/cwd/for/test', 10)).toEqual({
    ...DEFAULT_CONFIG,
    charBudget: MIN_CHAR_BUDGET,
  });
});
