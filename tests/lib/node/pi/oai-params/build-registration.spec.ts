/**
 * Tests for lib/node/pi/oai-params/build-registration.ts.
 */

import { describe, expect, test } from 'vitest';

import { buildRegistrations } from '../../../../../lib/node/pi/oai-params/build-registration.ts';
import type { ParsedVariant } from '../../../../../lib/node/pi/oai-params/types.ts';

const providers = {
  'llama-cpp': {
    baseUrl: 'https://llm.example.com/v1',
    api: 'openai-completions',
    apiKey: 'sk-local',
    headers: { Authorization: '${TOKEN}' },
    compat: { supportsDeveloperRole: true },
    models: [
      {
        id: 'qwen3-6-27b',
        name: 'Qwen 3.6 27B',
        input: ['text', 'image'],
        reasoning: true,
        contextWindow: 163840,
        maxTokens: 32768,
        compat: { thinkingFormat: 'qwen-chat-template' },
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      },
    ],
  },
  cloud: {
    baseUrl: 'https://api.anthropic.com',
    api: 'anthropic-messages',
    models: [
      { id: 'claude', name: 'Claude', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192 },
    ],
  },
};

const variant = (over: Partial<ParsedVariant> = {}): ParsedVariant => ({
  id: 'qwen-creative',
  name: 'Qwen Creative',
  parentProvider: 'llama-cpp',
  parentId: 'qwen3-6-27b',
  samplingParams: { temperature: 1.0, min_p: 0.05 },
  ...over,
});

describe('buildRegistrations', () => {
  test('clones the parent into a per-variant provider registration', () => {
    const { registrations, errors } = buildRegistrations([variant()], providers);
    expect(errors).toEqual([]);
    expect(registrations).toHaveLength(1);
    const reg = registrations[0];
    expect(reg.providerName).toBe('qwen-creative');
    expect(reg.baseUrl).toBe('https://llm.example.com/v1');
    expect(reg.apiKey).toBe('sk-local');
    expect(reg.api).toBe('openai-completions');
    expect(reg.headers).toEqual({ Authorization: '${TOKEN}' });
    expect(reg.models).toHaveLength(1);
    const m = reg.models[0];
    expect(m.id).toBe('qwen-creative');
    expect(m.name).toBe('Qwen Creative');
    expect(m.contextWindow).toBe(163840);
    expect(m.maxTokens).toBe(32768);
    expect(m.input).toEqual(['text', 'image']);
    // provider-level + model-level compat are merged (model wins).
    expect(m.compat).toEqual({ supportsDeveloperRole: true, thinkingFormat: 'qwen-chat-template' });
  });

  test('records the injection keyed by the synthetic provider name', () => {
    const { injections } = buildRegistrations([variant()], providers);
    expect(injections.get('qwen-creative')).toEqual({
      parentId: 'qwen3-6-27b',
      samplingParams: { temperature: 1.0, min_p: 0.05 },
    });
  });

  test('errors on an unknown provider', () => {
    const { registrations, errors } = buildRegistrations([variant({ parentProvider: 'nope' })], providers);
    expect(registrations).toEqual([]);
    expect(errors[0]).toContain('unknown provider "nope"');
  });

  test('errors on an unknown parent model id', () => {
    const { errors } = buildRegistrations([variant({ parentId: 'ghost' })], providers);
    expect(errors[0]).toContain('model "ghost" not found');
  });

  test('rejects a non-openai-completions parent', () => {
    const v = variant({ parentProvider: 'cloud', parentId: 'claude' });
    const { registrations, errors } = buildRegistrations([v], providers);
    expect(registrations).toEqual([]);
    expect(errors[0]).toContain('not openai-completions');
  });

  test('errors when parent model lacks contextWindow/maxTokens', () => {
    const bare = {
      p: {
        baseUrl: 'u',
        api: 'openai-completions',
        models: [{ id: 'm', name: 'M', reasoning: false, input: ['text'] }],
      },
    };
    const v = variant({ parentProvider: 'p', parentId: 'm' });
    const { errors } = buildRegistrations([v], bare);
    expect(errors[0]).toContain('contextWindow/maxTokens');
  });

  test('no providers object yields an error per variant', () => {
    const { errors } = buildRegistrations([variant()], undefined);
    expect(errors).toHaveLength(1);
  });
});
