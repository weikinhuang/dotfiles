import { describe, expect, test } from 'vitest';

import { buildMaskPlan, maskSvg, regionToBbox } from '../../../../../lib/node/pi/comfyui/mask.ts';

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

describe('maskSvg', () => {
  test('white rects on a black background by default (white = region to change)', () => {
    const svg = maskSvg({
      width: 64,
      height: 32,
      rects: [{ x: 8, y: 4, width: 16, height: 8 }],
      invert: false,
      feather: 0,
    });
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32">' +
        '<rect width="100%" height="100%" fill="#000"/>' +
        '<rect x="8" y="4" width="16" height="8" fill="#fff"/></svg>',
    );
  });

  test('invert flips both the background and rect fills', () => {
    const svg = maskSvg({
      width: 10,
      height: 10,
      rects: [{ x: 0, y: 0, width: 5, height: 5 }],
      invert: true,
      feather: 0,
    });
    expect(svg).toContain('<rect width="100%" height="100%" fill="#fff"/>');
    expect(svg).toContain('fill="#000"/></svg>');
  });

  test('emits one rect per filled region', () => {
    const svg = maskSvg({
      width: 100,
      height: 100,
      rects: [
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 50, y: 50, width: 20, height: 20 },
      ],
      invert: false,
      feather: 0,
    });
    expect(svg.match(/<rect /g)).toHaveLength(3); // 1 background + 2 regions
  });
});

describe('regionToBbox', () => {
  test('maps named regions to a thirds/halves grid', () => {
    expect(regionToBbox('center')).toEqual([0.25, 0.25, 0.5, 0.5]);
    expect(regionToBbox('top')).toEqual([0, 0, 1, 0.5]);
    expect(regionToBbox('bottom-right')).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(regionToBbox('left')).toEqual([0, 0, 0.5, 1]);
  });

  test('is case- and whitespace-insensitive', () => {
    expect(regionToBbox('  Top-Left ')).toEqual([0, 0, 0.5, 0.5]);
  });

  test('falls back to the whole image for unknown / empty / undefined regions', () => {
    expect(regionToBbox(undefined)).toEqual([0, 0, 1, 1]);
    expect(regionToBbox('')).toEqual([0, 0, 1, 1]);
    expect(regionToBbox('whole')).toEqual([0, 0, 1, 1]);
    expect(regionToBbox('somewhere')).toEqual([0, 0, 1, 1]);
  });

  test('produces a box that survives buildMaskPlan validation', () => {
    const { plan, error } = buildMaskPlan([Array.from(regionToBbox('center'))], 1024, 1024);
    expect(error).toBeUndefined();
    expect(plan?.rects).toEqual([{ x: 256, y: 256, width: 512, height: 512 }]);
  });
});
