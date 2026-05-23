/**
 * Tests for lib/node/pi/btw/model-spec.ts.
 */

import { describe, expect, test } from 'vitest';

import { parseModelSpec } from '../../../../../lib/node/pi/btw/model-spec.ts';

describe('parseModelSpec', () => {
  test('parses provider/modelId', () => {
    expect(parseModelSpec('anthropic/claude-opus-4-7')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
  });

  test('trims whitespace around each component', () => {
    expect(parseModelSpec('  anthropic  /  claude-opus-4-7  ')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
  });

  test('accepts modelIds that themselves contain slashes', () => {
    // Provider ends at the FIRST slash; the rest is the modelId.
    // Some model IDs (e.g. HuggingFace) legitimately have slashes.
    expect(parseModelSpec('huggingface/meta-llama/Llama-3.1-70B')).toEqual({
      provider: 'huggingface',
      modelId: 'meta-llama/Llama-3.1-70B',
    });
  });

  test('returns undefined for missing slash', () => {
    expect(parseModelSpec('claude-opus-4-7')).toBeUndefined();
  });

  test('returns undefined for empty provider or modelId', () => {
    expect(parseModelSpec('/claude-opus-4-7')).toBeUndefined();
    expect(parseModelSpec('anthropic/')).toBeUndefined();
    expect(parseModelSpec('/')).toBeUndefined();
  });

  test('returns undefined for empty / whitespace / undefined input', () => {
    expect(parseModelSpec('')).toBeUndefined();
    expect(parseModelSpec('   ')).toBeUndefined();
    expect(parseModelSpec(undefined)).toBeUndefined();
  });
});
