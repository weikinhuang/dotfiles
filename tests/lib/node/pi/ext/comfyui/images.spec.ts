/**
 * Tests for the pure (sharp-free) helpers in
 * lib/node/pi/ext/comfyui/images.ts: the bbox-spec type guard and the
 * preview-downscaler factory's on/off gating. The `sharp`-backed
 * rasterize / upload paths are exercised via the higher-level flows, not
 * here.
 */

import { describe, expect, test } from 'vitest';

import {
  isBboxSpec,
  previewTransformFor,
  type RoleImageInput,
} from '../../../../../../lib/node/pi/ext/comfyui/images.ts';

describe('isBboxSpec', () => {
  test('true for an object carrying a bbox array', () => {
    expect(isBboxSpec({ bbox: [[0, 0, 1, 1]] })).toBe(true);
  });
  test('false for a plain path string', () => {
    expect(isBboxSpec('~/in.png')).toBe(false);
  });
  test('false for an object without a bbox array', () => {
    expect(isBboxSpec({ feather: 4 } as unknown as RoleImageInput)).toBe(false);
    expect(isBboxSpec({ bbox: 'nope' } as unknown as RoleImageInput)).toBe(false);
  });
});

describe('previewTransformFor', () => {
  test('returns a transform fn for a positive cap', () => {
    expect(typeof previewTransformFor(768)).toBe('function');
  });
  test('off (undefined) for an absent, zero, or negative cap', () => {
    expect(previewTransformFor(undefined)).toBeUndefined();
    expect(previewTransformFor(0)).toBeUndefined();
    expect(previewTransformFor(-1)).toBeUndefined();
  });
});
