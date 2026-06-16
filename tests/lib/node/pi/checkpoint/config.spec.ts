/**
 * Tests for lib/node/pi/checkpoint/config.ts.
 *
 * Pure module - no pi runtime. Pins the coercion (drop wrong-typed fields),
 * the layering precedence (later layer wins, `full` deep-merges), and the
 * PI_CHECKPOINT_DISABLE_FULL force.
 */

import { describe, expect, test } from 'vitest';

import {
  coerceConfigLayer,
  DEFAULT_CONFIG,
  envConfigLayer,
  mergeConfigLayers,
} from '../../../../../lib/node/pi/checkpoint/config.ts';

describe('coerceConfigLayer', () => {
  test('returns empty for non-object input', () => {
    expect(coerceConfigLayer(null)).toEqual({});
    expect(coerceConfigLayer(42)).toEqual({});
    expect(coerceConfigLayer([1, 2])).toEqual({});
  });

  test('keeps valid scalars, drops wrong types', () => {
    const layer = coerceConfigLayer({
      mode: 'full',
      autoReviewOnNavigate: 'auto',
      reviewOnFork: false,
      hideNoOpRows: 'yes', // wrong type → dropped
      maxFileBytes: 1024,
      retentionDays: 0,
    });
    expect(layer).toEqual({
      mode: 'full',
      autoReviewOnNavigate: 'auto',
      reviewOnFork: false,
      maxFileBytes: 1024,
      retentionDays: 0,
    });
  });

  test('rejects invalid enum values', () => {
    expect(coerceConfigLayer({ mode: 'turbo' }).mode).toBeUndefined();
    expect(coerceConfigLayer({ autoReviewOnNavigate: 'maybe' }).autoReviewOnNavigate).toBeUndefined();
  });

  test('maxFileBytes must be positive; retentionDays may be zero but not negative', () => {
    expect(coerceConfigLayer({ maxFileBytes: 0 }).maxFileBytes).toBeUndefined();
    expect(coerceConfigLayer({ maxFileBytes: -1 }).maxFileBytes).toBeUndefined();
    expect(coerceConfigLayer({ retentionDays: 0 }).retentionDays).toBe(0);
    expect(coerceConfigLayer({ retentionDays: -5 }).retentionDays).toBeUndefined();
  });

  test('coerces the nested full block, dropping it when all fields are bad', () => {
    expect(coerceConfigLayer({ full: { maxStagedFiles: 10, confirmClean: false } }).full).toEqual({
      maxStagedFiles: 10,
      confirmClean: false,
    });
    expect(coerceConfigLayer({ full: { maxStagedFiles: 'lots' } }).full).toBeUndefined();
    expect(coerceConfigLayer({ full: 'nope' }).full).toBeUndefined();
  });
});

describe('mergeConfigLayers', () => {
  test('no layers yields the defaults (independent copy of full)', () => {
    const merged = mergeConfigLayers();
    expect(merged).toEqual(DEFAULT_CONFIG);
    expect(merged.full).not.toBe(DEFAULT_CONFIG.full);
  });

  test('later layer wins for scalars', () => {
    const merged = mergeConfigLayers({ mode: 'full' }, { mode: 'tool' });
    expect(merged.mode).toBe('tool');
  });

  test('full block deep-merges by field across layers', () => {
    const merged = mergeConfigLayers({ full: { maxStagedFiles: 10 } }, { full: { confirmClean: false } });
    expect(merged.full).toEqual({
      maxStagedFiles: 10,
      maxStagedBytes: DEFAULT_CONFIG.full.maxStagedBytes,
      confirmClean: false,
    });
  });
});

describe('envConfigLayer', () => {
  test('forces tool mode when disableFull is set', () => {
    expect(envConfigLayer(true)).toEqual({ mode: 'tool' });
  });

  test('is empty when disableFull is unset', () => {
    expect(envConfigLayer(false)).toEqual({});
  });

  test('disableFull force beats a config file selecting full', () => {
    // envLayer sits lowest, but the shell re-applies the force last; this
    // pins the layer value the shell starts from.
    const merged = mergeConfigLayers(envConfigLayer(true), { mode: 'full' });
    // Layering alone lets the project config win - the shell's post-merge
    // force is what guarantees tool mode (asserted in the extension spec).
    expect(merged.mode).toBe('full');
  });
});
