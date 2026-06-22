import { describe, expect, test } from 'vitest';

import { buildMaskPlan } from '../../../../../lib/node/pi/comfyui/mask.ts';

describe('buildMaskPlan', () => {
  test('scales a single normalized box to pixels', () => {
    const { plan, error } = buildMaskPlan([[0.25, 0.5, 0.5, 0.25]], 1024, 1024);
    expect(error).toBeUndefined();
    expect(plan).toEqual({
      width: 1024,
      height: 1024,
      rects: [{ x: 256, y: 512, width: 512, height: 256 }],
      invert: false,
      feather: 0,
    });
  });

  test('unions multiple boxes and carries invert + feather', () => {
    const { plan } = buildMaskPlan(
      [
        [0, 0, 0.5, 0.5],
        [0.5, 0.5, 0.5, 0.5],
      ],
      100,
      100,
      { invert: true, feather: 4 },
    );
    expect(plan?.rects).toEqual([
      { x: 0, y: 0, width: 50, height: 50 },
      { x: 50, y: 50, width: 50, height: 50 },
    ]);
    expect(plan?.invert).toBe(true);
    expect(plan?.feather).toBe(4);
  });

  test('fills to the bottom-right corner for an edge-touching box', () => {
    const { plan } = buildMaskPlan([[0.9, 0.9, 0.1, 0.1]], 100, 100);
    expect(plan?.rects).toEqual([{ x: 90, y: 90, width: 10, height: 10 }]);
  });

  test('floors a sub-pixel-but-valid box to at least 1px', () => {
    const { plan } = buildMaskPlan([[0, 0, 0.001, 0.001]], 100, 100);
    expect(plan?.rects).toEqual([{ x: 0, y: 0, width: 1, height: 1 }]);
  });

  test('rejects an empty box list', () => {
    expect(buildMaskPlan([], 100, 100).error).toMatch(/at least one/);
  });

  test('rejects a malformed box', () => {
    expect(buildMaskPlan([[0, 0, 0.5]], 100, 100).error).toMatch(/four numbers/);
    expect(buildMaskPlan([[0, 0, 0.5, Number.NaN]], 100, 100).error).toMatch(/four numbers/);
  });

  test('rejects zero / negative area', () => {
    expect(buildMaskPlan([[0, 0, 0, 0.5]], 100, 100).error).toMatch(/zero or negative/);
    expect(buildMaskPlan([[0, 0, -0.5, 0.5]], 100, 100).error).toMatch(/zero or negative/);
  });

  test('rejects a box outside 0..1', () => {
    expect(buildMaskPlan([[0.8, 0, 0.5, 0.5]], 100, 100).error).toMatch(/outside the normalized/);
    expect(buildMaskPlan([[-0.1, 0, 0.5, 0.5]], 100, 100).error).toMatch(/outside the normalized/);
  });

  test('rejects a bad canvas or feather', () => {
    expect(buildMaskPlan([[0, 0, 1, 1]], 0, 100).error).toMatch(/positive width and height/);
    expect(buildMaskPlan([[0, 0, 1, 1]], 100, 100, { feather: -1 }).error).toMatch(/feather/);
  });
});
