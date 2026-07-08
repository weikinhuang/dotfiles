/**
 * Tests for lib/node/pi/llama-thinking-budget/inject.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  computeInjection,
  type InjectDecision,
  type InjectInputs,
} from '../../../../../lib/node/pi/llama-thinking-budget/inject.ts';
import type { InjectionConfig } from '../../../../../lib/node/pi/llama-thinking-budget/types.ts';

const injection: InjectionConfig = {
  field: 'thinking_budget_tokens',
  stripEffort: false,
  budgets: { minimal: 100, low: 200, medium: 300, high: 400 },
};

/** Assert the decision is an inject and narrow it, so tests can read `payload` unconditionally. */
function asInject(out: InjectDecision): Extract<InjectDecision, { action: 'inject' }> {
  expect(out.action).toBe('inject');
  if (out.action !== 'inject') throw new Error(`expected inject, got ${out.action}`);
  return out;
}

function inputs(overrides: Partial<InjectInputs>): InjectInputs {
  return {
    payload: {},
    providerName: 'llama-cpp',
    modelId: 'qwen3',
    providers: new Map([['llama-cpp', injection]]),
    settings: {},
    env: {},
    getSessionLevel: () => undefined,
    ...overrides,
  };
}

describe('computeInjection detection', () => {
  test('skips a non-object payload', () => {
    expect(computeInjection(inputs({ payload: null }))).toEqual({ action: 'skip', trace: 'skip: payload not object' });
  });

  test('injects on a reasoning_effort signal without consulting the session', () => {
    let consulted = false;
    const out = computeInjection(
      inputs({
        payload: { reasoning_effort: 'medium' },
        getSessionLevel: () => {
          consulted = true;
          return undefined;
        },
      }),
    );
    expect(consulted).toBe(false);
    const inj = asInject(out);
    expect(inj.payload).toEqual({ reasoning_effort: 'medium', thinking_budget_tokens: 300 });
    expect(inj.trace).toContain('via=reasoning_effort effort=medium thinking_budget_tokens=300 strip=false');
  });

  test('reads the session level for chat_template_kwargs.enable_thinking', () => {
    const out = computeInjection(
      inputs({
        payload: { chat_template_kwargs: { enable_thinking: true } },
        getSessionLevel: () => 'high',
      }),
    );
    const inj = asInject(out);
    expect(inj.payload.thinking_budget_tokens).toBe(400);
    expect(inj.trace).toContain('via=chat_template_kwargs.enable_thinking effort=high');
  });

  test('reads the session level for top-level enable_thinking', () => {
    const out = computeInjection(inputs({ payload: { enable_thinking: true }, getSessionLevel: () => 'low' }));
    const inj = asInject(out);
    expect(inj.payload.thinking_budget_tokens).toBe(200);
    expect(inj.trace).toContain('via=enable_thinking effort=low');
  });

  test('skips when there is no reasoning signal', () => {
    expect(computeInjection(inputs({ payload: { messages: [] } }))).toEqual({
      action: 'skip',
      trace: 'skip: no reasoning signal in payload (not a thinking request)',
    });
  });

  test('skips when a boolean signal has no session level', () => {
    expect(computeInjection(inputs({ payload: { enable_thinking: true }, getSessionLevel: () => undefined }))).toEqual({
      action: 'skip',
      trace: 'skip: detected enable_thinking but no current thinking level in session',
    });
  });
});

describe('computeInjection provider / model gating', () => {
  test('skips when the model has no provider', () => {
    expect(computeInjection(inputs({ payload: { reasoning_effort: 'low' }, providerName: undefined }))).toEqual({
      action: 'skip',
      trace: 'skip: no ctx.model.provider',
    });
  });

  test('skips when the provider is not opted in, listing the known providers', () => {
    const out = computeInjection(inputs({ payload: { reasoning_effort: 'low' }, providerName: 'other' }));
    expect(out).toEqual({ action: 'skip', trace: 'skip: provider "other" not opted in (have: llama-cpp)' });
  });

  test('reports <none> when no providers are opted in', () => {
    const out = computeInjection(
      inputs({ payload: { reasoning_effort: 'low' }, providerName: 'other', providers: new Map() }),
    );
    expect(out.trace).toBe('skip: provider "other" not opted in (have: <none>)');
  });

  test('skips a model outside the allow-list', () => {
    const gated: InjectionConfig = { ...injection, models: new Set(['allowed']) };
    const out = computeInjection(
      inputs({
        payload: { reasoning_effort: 'low' },
        modelId: 'blocked',
        providers: new Map([['llama-cpp', gated]]),
      }),
    );
    expect(out).toEqual({ action: 'skip', trace: 'skip: model "blocked" not in allow-list' });
  });

  test('injects for a model in the allow-list', () => {
    const gated: InjectionConfig = { ...injection, models: new Set(['allowed']) };
    const out = computeInjection(
      inputs({
        payload: { reasoning_effort: 'low' },
        modelId: 'allowed',
        providers: new Map([['llama-cpp', gated]]),
      }),
    );
    expect(out.action).toBe('inject');
  });
});

describe('computeInjection budget + payload assembly', () => {
  test('skips an invalid (non-positive) resolved budget', () => {
    const zeroed: InjectionConfig = { field: 'f', stripEffort: false, budgets: {} };
    const out = computeInjection(
      inputs({
        payload: { reasoning_effort: 'medium' },
        providers: new Map([['llama-cpp', zeroed]]),
        settings: { medium: 0 },
        env: { medium: 0 },
      }),
    );
    // env 0 / settings 0 are stripped by parsing, but a direct 0 layer here
    // exercises the invalid-budget guard.
    expect(out.action).toBe('skip');
  });

  test('strips reasoning_effort when stripEffort is set', () => {
    const stripping: InjectionConfig = { ...injection, stripEffort: true };
    const out = computeInjection(
      inputs({
        payload: { reasoning_effort: 'high', keep: 1 },
        providers: new Map([['llama-cpp', stripping]]),
      }),
    );
    const inj = asInject(out);
    expect(inj.payload).toEqual({ keep: 1, thinking_budget_tokens: 400 });
    expect(inj.payload.reasoning_effort).toBeUndefined();
    expect(inj.trace).toContain('strip=true');
  });

  test('uses the configured field name and preserves other payload keys', () => {
    const renamed: InjectionConfig = { ...injection, field: 'thinking_tokens' };
    const out = computeInjection(
      inputs({
        payload: { reasoning_effort: 'minimal', temperature: 0.5 },
        providers: new Map([['llama-cpp', renamed]]),
      }),
    );
    const inj = asInject(out);
    expect(inj.payload).toEqual({ reasoning_effort: 'minimal', temperature: 0.5, thinking_tokens: 100 });
  });
});
