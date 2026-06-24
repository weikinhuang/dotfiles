/**
 * Tests for lib/node/pi/ext/comfyui/layer-params.ts - the per-field
 * precedence when resolving the `generate_image` params against an aspect
 * preset, a reused (`variationOf`) generation, and the config `defaults`.
 */

import { describe, expect, test } from 'vitest';

import { layerGenerationParams } from '../../../../../../lib/node/pi/ext/comfyui/layer-params.ts';
import type { GenerateParams } from '../../../../../../lib/node/pi/ext/comfyui/params.ts';

const empty: GenerateParams = {};

describe('layerGenerationParams', () => {
  test('per-call params win over every fallback', () => {
    const r = layerGenerationParams({
      params: { prompt: 'ignored', seed: 1, width: 100, height: 200, steps: 10, cfg: 5, denoise: 0.4, count: 3 },
      prompt: 'a cat',
      reuse: { seed: 9, width: 999, height: 999 },
      aspectDims: { width: 512, height: 512 },
      defaults: { width: 768, height: 768, steps: 30, cfg: 7, denoise: 1, count: 1 },
      roleMode: false,
    });
    expect(r).toMatchObject({
      prompt: 'a cat',
      seed: 1,
      width: 100,
      height: 200,
      steps: 10,
      cfg: 5,
      denoise: 0.4,
      count: 3,
    });
  });

  test('aspect dims beat reuse + defaults but lose to explicit dims', () => {
    const r = layerGenerationParams({
      params: empty,
      prompt: 'x',
      aspectDims: { width: 1280, height: 720 },
      reuse: { seed: 1, width: 100, height: 100 },
      defaults: { width: 512, height: 512 },
      roleMode: false,
    });
    expect(r.width).toBe(1280);
    expect(r.height).toBe(720);
  });

  test('reuse fills seed/dims when neither param nor aspect provide them', () => {
    const r = layerGenerationParams({
      params: empty,
      prompt: 'x',
      reuse: { seed: 42, width: 640, height: 480 },
      roleMode: false,
    });
    expect(r).toMatchObject({ seed: 42, width: 640, height: 480 });
  });

  test('defaults are the last fallback before the workflow-baked graph value', () => {
    const r = layerGenerationParams({
      params: empty,
      prompt: 'x',
      defaults: { width: 768, height: 768, steps: 28, cfg: 6, denoise: 0.8, count: 2 },
      roleMode: false,
    });
    expect(r).toMatchObject({ width: 768, height: 768, steps: 28, cfg: 6, denoise: 0.8, count: 2 });
  });

  describe('negative precedence', () => {
    test('enhanced negative replaces the baseline', () => {
      const r = layerGenerationParams({
        params: empty,
        prompt: 'x',
        enhancedNegative: 'enh',
        baselineNegative: 'base',
        roleMode: false,
      });
      expect(r.negative).toBe('enh');
    });
    test('falls back to the caller-resolved baseline when no enhancement ran', () => {
      // The caller pre-folds `param ?? reuse ?? defaults` into baselineNegative.
      const r = layerGenerationParams({ params: empty, prompt: 'x', baselineNegative: 'base', roleMode: false });
      expect(r.negative).toBe('base');
    });
    test('undefined when neither is set', () => {
      const r = layerGenerationParams({ params: empty, prompt: 'x', roleMode: false });
      expect(r.negative).toBeUndefined();
    });
  });

  describe('inputImages', () => {
    test('a refine image becomes the sole positional input in non-role mode', () => {
      const r = layerGenerationParams({
        params: { inputImages: ['/a.png'] },
        prompt: 'x',
        refineImage: '/refine.png',
        roleMode: false,
      });
      expect(r.inputImages).toEqual(['/refine.png']);
    });
    test('role mode drops positional inputImages entirely', () => {
      const r = layerGenerationParams({
        params: { inputImages: ['/a.png'] },
        prompt: 'x',
        refineImage: '/refine.png',
        roleMode: true,
      });
      expect(r.inputImages).toBeUndefined();
    });
    test('passes the call inputImages through when there is no refine', () => {
      const r = layerGenerationParams({ params: { inputImages: ['/a.png', '/b.png'] }, prompt: 'x', roleMode: false });
      expect(r.inputImages).toEqual(['/a.png', '/b.png']);
    });
  });
});
