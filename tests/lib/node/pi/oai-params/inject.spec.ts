/**
 * Tests for lib/node/pi/oai-params/inject.ts.
 */

import { describe, expect, test } from 'vitest';

import { computeInjection } from '../../../../../lib/node/pi/oai-params/inject.ts';
import type { VariantInjection } from '../../../../../lib/node/pi/oai-params/types.ts';

const injections = new Map<string, VariantInjection>([
  ['qwen-creative', { parentId: 'qwen3-6-27b', samplingParams: { temperature: 1.0, min_p: 0.05, top_k: 40 } }],
]);

describe('computeInjection', () => {
  test('skips when provider is not a known variant', () => {
    const d = computeInjection({ payload: { model: 'x' }, provider: 'llama-cpp', injections });
    expect(d.action).toBe('skip');
  });

  test('skips when provider is undefined', () => {
    expect(computeInjection({ payload: {}, provider: undefined, injections }).action).toBe('skip');
  });

  test('rewrites model to the parent id and fills sampling params', () => {
    const d = computeInjection({
      payload: { model: 'qwen-creative', messages: [], stream: true },
      provider: 'qwen-creative',
      injections,
    });
    expect(d.action).toBe('inject');
    expect(d.payload).toEqual({
      model: 'qwen3-6-27b',
      messages: [],
      stream: true,
      temperature: 1.0,
      min_p: 0.05,
      top_k: 40,
    });
  });

  test('does not overwrite a key pi already set (fill-only)', () => {
    const d = computeInjection({
      payload: { model: 'qwen-creative', temperature: 0.2 },
      provider: 'qwen-creative',
      injections,
    });
    // pi-set temperature preserved; other params still filled.
    expect(d.payload!.temperature).toBe(0.2);
    expect(d.payload!.min_p).toBe(0.05);
    expect(d.trace).toContain('temperature(present)');
  });

  test('always rewrites model even with empty params', () => {
    const map = new Map<string, VariantInjection>([['v', { parentId: 'real-id', samplingParams: {} }]]);
    const d = computeInjection({ payload: { model: 'v' }, provider: 'v', injections: map });
    expect(d.action).toBe('inject');
    expect(d.payload!.model).toBe('real-id');
  });

  test('does not mutate the input payload', () => {
    const payload = { model: 'qwen-creative' };
    computeInjection({ payload, provider: 'qwen-creative', injections });
    expect(payload).toEqual({ model: 'qwen-creative' });
  });

  test('skips a non-object payload', () => {
    expect(computeInjection({ payload: null, provider: 'qwen-creative', injections }).action).toBe('skip');
    expect(computeInjection({ payload: [1], provider: 'qwen-creative', injections }).action).toBe('skip');
  });
});
