/**
 * Tests for lib/node/pi/oai-params/config.ts.
 */

import { describe, expect, test } from 'vitest';

import { parseExtends, parseSamplingParams, parseVariants } from '../../../../../lib/node/pi/oai-params/config.ts';

describe('parseExtends', () => {
  test('splits provider/id on the first slash', () => {
    expect(parseExtends('llama-cpp/qwen3-6-27b')).toEqual({ provider: 'llama-cpp', id: 'qwen3-6-27b' });
  });

  test('keeps slashes in the id portion', () => {
    expect(parseExtends('openrouter/meta/llama-3')).toEqual({ provider: 'openrouter', id: 'meta/llama-3' });
  });

  test('rejects missing / empty sides and non-strings', () => {
    expect(parseExtends('noslash')).toBeUndefined();
    expect(parseExtends('/id')).toBeUndefined();
    expect(parseExtends('provider/')).toBeUndefined();
    expect(parseExtends(42)).toBeUndefined();
    expect(parseExtends(undefined)).toBeUndefined();
  });
});

describe('parseSamplingParams', () => {
  test('keeps arbitrary JSON-typed keys', () => {
    expect(parseSamplingParams({ temperature: 0.7, min_p: 0.05, top_k: 40, custom_flag: true })).toEqual({
      temperature: 0.7,
      min_p: 0.05,
      top_k: 40,
      custom_flag: true,
    });
  });

  test('drops reserved payload keys and reports them', () => {
    const dropped: string[] = [];
    const out = parseSamplingParams({ temperature: 1, model: 'x', messages: [], tools: [] }, (k) => dropped.push(k));
    expect(out).toEqual({ temperature: 1 });
    expect(dropped.sort()).toEqual(['messages', 'model', 'tools']);
  });

  test('non-object input yields empty', () => {
    expect(parseSamplingParams(undefined)).toEqual({});
    expect(parseSamplingParams('nope')).toEqual({});
    expect(parseSamplingParams([1, 2])).toEqual({});
  });
});

describe('parseVariants', () => {
  test('parses a well-formed entry with defaults', () => {
    const { variants, errors } = parseVariants({
      'qwen-creative': { extends: 'llama-cpp/qwen3-6-27b', samplingParams: { temperature: 1.0 } },
    });
    expect(errors).toEqual([]);
    expect(variants).toEqual([
      {
        id: 'qwen-creative',
        name: 'qwen-creative',
        parentProvider: 'llama-cpp',
        parentId: 'qwen3-6-27b',
        samplingParams: { temperature: 1.0 },
      },
    ]);
  });

  test('honors an explicit display name', () => {
    const { variants } = parseVariants({
      v: { extends: 'p/m', name: 'Fancy Name' },
    });
    expect(variants[0].name).toBe('Fancy Name');
    expect(variants[0].samplingParams).toEqual({});
  });

  test('reports malformed extends and skips the entry', () => {
    const { variants, errors } = parseVariants({ bad: { extends: 'noslash' } });
    expect(variants).toEqual([]);
    expect(errors[0]).toContain('bad');
    expect(errors[0]).toContain('extends');
  });

  test('ignores non-object entries (e.g. a $schema string)', () => {
    const { variants, errors } = parseVariants({ $schema: 'https://x', good: { extends: 'p/m' } });
    expect(variants.map((v) => v.id)).toEqual(['good']);
    expect(errors).toEqual([]);
  });

  test('non-object root yields empty', () => {
    expect(parseVariants(null).variants).toEqual([]);
    expect(parseVariants([]).variants).toEqual([]);
  });
});
