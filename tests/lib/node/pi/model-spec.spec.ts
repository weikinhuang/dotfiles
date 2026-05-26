/**
 * Tests for lib/node/pi/model-spec.ts.
 */

import { describe, expect, test } from 'vitest';

import { parseModelSpec, parseModelSpecCore, parseStrictModelSpec } from '../../../../lib/node/pi/model-spec.ts';

describe('parseModelSpec', () => {
  test('trims input and components for config/env callers', () => {
    expect(parseModelSpec('  anthropic  /  claude-opus-4-7  ')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
  });

  test('keeps model id slashes after the first slash', () => {
    expect(parseModelSpec('huggingface/meta-llama/Llama-3.1-70B')).toEqual({
      provider: 'huggingface',
      modelId: 'meta-llama/Llama-3.1-70B',
    });
  });
});

describe('parseStrictModelSpec', () => {
  test('accepts provider/id without trimming', () => {
    expect(parseStrictModelSpec('openai/gpt-5')).toEqual({ provider: 'openai', modelId: 'gpt-5' });
  });

  test('rejects component whitespace with the research diagnostic', () => {
    expect(parseStrictModelSpec(' openai/gpt-5')).toEqual({
      error: 'invalid model override " openai/gpt-5" - provider / id must not have leading or trailing whitespace',
    });
  });

  test('rejects empty and slashless input with existing diagnostics', () => {
    expect(parseStrictModelSpec('')).toEqual({ error: 'model override must be a non-empty "provider/id" string' });
    expect(parseStrictModelSpec('openai')).toEqual({
      error: 'invalid model override "openai" - expected "provider/id"',
    });
  });
});

describe('parseModelSpecCore', () => {
  test('reports failure reasons for wrappers', () => {
    expect(parseModelSpecCore(undefined)).toEqual({ ok: false, failure: 'empty' });
    expect(parseModelSpecCore('openai')).toEqual({ ok: false, failure: 'missing-slash' });
    expect(parseModelSpecCore('openai/')).toEqual({ ok: false, failure: 'missing-slash' });
    expect(parseModelSpecCore('openai/ gpt', { rejectComponentWhitespace: true })).toEqual({
      ok: false,
      failure: 'component-whitespace',
    });
  });
});
