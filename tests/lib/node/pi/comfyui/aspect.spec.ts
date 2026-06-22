/**
 * Tests for lib/node/pi/comfyui/aspect.ts.
 */

import { describe, expect, test } from 'vitest';

import { DEFAULT_TARGET_PIXELS, parseAspectRatio, resolveAspect } from '../../../../../lib/node/pi/comfyui/aspect.ts';

describe('parseAspectRatio', () => {
  test('named presets', () => {
    expect(parseAspectRatio('square')).toEqual([1, 1]);
    expect(parseAspectRatio('Portrait')).toEqual([3, 4]);
    expect(parseAspectRatio('WIDE')).toEqual([16, 9]);
    expect(parseAspectRatio('widescreen')).toEqual([16, 9]);
  });

  test('W:H and W x H forms', () => {
    expect(parseAspectRatio('16:9')).toEqual([16, 9]);
    expect(parseAspectRatio('4 x 3')).toEqual([4, 3]);
    expect(parseAspectRatio('1.5:1')).toEqual([1.5, 1]);
  });

  test('rejects garbage and non-positive', () => {
    expect(parseAspectRatio('')).toBeUndefined();
    expect(parseAspectRatio('banana')).toBeUndefined();
    expect(parseAspectRatio('16:0')).toBeUndefined();
    expect(parseAspectRatio('0:9')).toBeUndefined();
    expect(parseAspectRatio('16/9')).toBeUndefined();
  });
});

describe('resolveAspect', () => {
  test('square at default budget is ~1024x1024, grid-snapped', () => {
    expect(resolveAspect('square')).toEqual({ width: 1024, height: 1024 });
  });

  test('preserves ratio and stays near the target area', () => {
    const r = resolveAspect('16:9');
    expect(r).toBeDefined();
    const { width, height } = r ?? { width: 0, height: 0 };
    expect(width % 8).toBe(0);
    expect(height % 8).toBe(0);
    expect(width).toBeGreaterThan(height);
    // ratio close to 16/9
    expect(width / height).toBeCloseTo(16 / 9, 1);
    // area within ~10% of the target
    expect(Math.abs(width * height - DEFAULT_TARGET_PIXELS) / DEFAULT_TARGET_PIXELS).toBeLessThan(0.1);
  });

  test('honors a custom target pixel budget', () => {
    const r = resolveAspect('square', 512 * 512);
    expect(r).toEqual({ width: 512, height: 512 });
  });

  test('invalid target falls back to default budget', () => {
    expect(resolveAspect('square', -1)).toEqual({ width: 1024, height: 1024 });
    expect(resolveAspect('square', 0)).toEqual({ width: 1024, height: 1024 });
  });

  test('returns undefined for an unparseable aspect', () => {
    expect(resolveAspect('nonsense')).toBeUndefined();
  });
});
