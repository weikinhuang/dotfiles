import { describe, expect, test } from 'vitest';

import { isResizableMime, planDownscale } from '../../../../../lib/node/pi/comfyui/preview.ts';

describe('planDownscale', () => {
  test('returns null when the image already fits', () => {
    expect(planDownscale(800, 600, 1024)).toBeNull();
    expect(planDownscale(1024, 768, 1024)).toBeNull();
  });

  test('scales the longer side down to maxDim, preserving aspect', () => {
    expect(planDownscale(2048, 1024, 1024)).toEqual({ width: 1024, height: 512 });
    expect(planDownscale(1024, 2048, 1024)).toEqual({ width: 512, height: 1024 });
  });

  test('rounds to the nearest pixel', () => {
    // 1500x1000 at maxDim 1000 -> scale 2/3 -> 1000 x 666.67 -> 667
    expect(planDownscale(1500, 1000, 1000)).toEqual({ width: 1000, height: 667 });
  });

  test('floors a collapsed side at 1px for an extreme aspect', () => {
    expect(planDownscale(10000, 5, 1000)).toEqual({ width: 1000, height: 1 });
  });

  test('disabled when maxDim is not a positive finite number', () => {
    expect(planDownscale(2048, 2048, 0)).toBeNull();
    expect(planDownscale(2048, 2048, -1)).toBeNull();
    expect(planDownscale(2048, 2048, Number.NaN)).toBeNull();
    expect(planDownscale(2048, 2048, Number.POSITIVE_INFINITY)).toBeNull();
  });

  test('null when source dimensions are unknown / invalid', () => {
    expect(planDownscale(0, 600, 512)).toBeNull();
    expect(planDownscale(800, 0, 512)).toBeNull();
    expect(planDownscale(Number.NaN, 600, 512)).toBeNull();
    expect(planDownscale(-800, 600, 512)).toBeNull();
  });
});

describe('isResizableMime', () => {
  test('still raster image formats are resizable', () => {
    expect(isResizableMime('image/png')).toBe(true);
    expect(isResizableMime('image/jpeg')).toBe(true);
    expect(isResizableMime('image/webp')).toBe(true);
  });

  test('case / whitespace tolerant', () => {
    expect(isResizableMime('  IMAGE/PNG  ')).toBe(true);
  });

  test('animated / non-image outputs pass through', () => {
    expect(isResizableMime('image/gif')).toBe(false);
    expect(isResizableMime('audio/mpeg')).toBe(false);
    expect(isResizableMime('video/mp4')).toBe(false);
    expect(isResizableMime('')).toBe(false);
  });
});
