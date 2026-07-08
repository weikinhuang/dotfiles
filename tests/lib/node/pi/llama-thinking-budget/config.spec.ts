/**
 * Tests for lib/node/pi/llama-thinking-budget/config.ts.
 */

import { describe, expect, test } from 'vitest';

import { parseBudgets, parseInjection } from '../../../../../lib/node/pi/llama-thinking-budget/config.ts';

describe('parseBudgets', () => {
  test('keeps positive-integer levels and drops the rest', () => {
    expect(parseBudgets({ minimal: 100, low: 200, medium: 300, high: 400 })).toEqual({
      minimal: 100,
      low: 200,
      medium: 300,
      high: 400,
    });
  });

  test('drops non-positive, non-numeric, and unknown keys', () => {
    expect(parseBudgets({ minimal: 0, low: -5, medium: 'lots', high: 512, extra: 1 })).toEqual({ high: 512 });
  });

  test('coerces numeric strings and floors positive numbers', () => {
    expect(parseBudgets({ minimal: '1024', low: 2048.9 })).toEqual({ minimal: 1024, low: 2048 });
  });

  test('non-object input yields an empty map', () => {
    expect(parseBudgets(null)).toEqual({});
    expect(parseBudgets('nope')).toEqual({});
    expect(parseBudgets(42)).toEqual({});
  });
});

describe('parseInjection', () => {
  test('applies defaults for field and stripEffort', () => {
    const out = parseInjection({});
    expect(out).toEqual({ field: 'thinking_budget_tokens', stripEffort: false, models: undefined, budgets: {} });
  });

  test('parses a full block', () => {
    const out = parseInjection({
      field: 'thinking_tokens',
      stripEffort: true,
      models: ['a', 'b'],
      budgets: { medium: 8192 },
    });
    expect(out?.field).toBe('thinking_tokens');
    expect(out?.stripEffort).toBe(true);
    expect(out?.models).toEqual(new Set(['a', 'b']));
    expect(out?.budgets).toEqual({ medium: 8192 });
  });

  test('trims a whitespace field and falls back when blank / wrong-typed', () => {
    expect(parseInjection({ field: '  spaced  ' })?.field).toBe('spaced');
    expect(parseInjection({ field: '   ' })?.field).toBe('thinking_budget_tokens');
    expect(parseInjection({ field: 42 })?.field).toBe('thinking_budget_tokens');
  });

  test('stripEffort is only true for a literal true', () => {
    expect(parseInjection({ stripEffort: 'yes' })?.stripEffort).toBe(false);
    expect(parseInjection({ stripEffort: 1 })?.stripEffort).toBe(false);
    expect(parseInjection({ stripEffort: true })?.stripEffort).toBe(true);
  });

  test('models filters out non-string / empty entries; absent when not an array', () => {
    expect(parseInjection({ models: ['a', '', 3, 'b'] })?.models).toEqual(new Set(['a', 'b']));
    expect(parseInjection({ models: 'a' })?.models).toBeUndefined();
    expect(parseInjection({})?.models).toBeUndefined();
  });

  test('returns undefined for non-object input', () => {
    expect(parseInjection(null)).toBeUndefined();
    expect(parseInjection('x')).toBeUndefined();
    expect(parseInjection(undefined)).toBeUndefined();
  });
});
