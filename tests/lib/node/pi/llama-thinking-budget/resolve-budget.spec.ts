/**
 * Tests for lib/node/pi/llama-thinking-budget/resolve-budget.ts.
 */

import { describe, expect, test } from 'vitest';

import { envBudgets, resolveBudget } from '../../../../../lib/node/pi/llama-thinking-budget/resolve-budget.ts';
import type { InjectionConfig } from '../../../../../lib/node/pi/llama-thinking-budget/types.ts';

describe('envBudgets', () => {
  test('reads each PI_LLAMA_BUDGET_* level, leaving invalid ones undefined', () => {
    const out = envBudgets({
      PI_LLAMA_BUDGET_MINIMAL: '512',
      PI_LLAMA_BUDGET_LOW: '0',
      PI_LLAMA_BUDGET_MEDIUM: 'nope',
      PI_LLAMA_BUDGET_HIGH: '16384',
    });
    expect(out).toEqual({ minimal: 512, low: undefined, medium: undefined, high: 16384 });
  });

  test('all levels undefined when env is empty', () => {
    expect(envBudgets({})).toEqual({ minimal: undefined, low: undefined, medium: undefined, high: undefined });
  });
});

describe('resolveBudget', () => {
  const injection: InjectionConfig = {
    field: 'thinking_budget_tokens',
    stripEffort: false,
    budgets: { medium: 5000 },
  };

  test('env wins over provider budgets, settings, and defaults', () => {
    expect(resolveBudget('medium', injection, { medium: 7000 }, { medium: 3000 })).toBe(3000);
  });

  test('provider budget wins over settings and defaults when env is unset', () => {
    expect(resolveBudget('medium', injection, { medium: 7000 }, {})).toBe(5000);
  });

  test('settings win over the built-in default when env + provider are unset', () => {
    expect(resolveBudget('low', injection, { low: 999 }, {})).toBe(999);
  });

  test('falls back to the built-in default when nothing else supplies a value', () => {
    expect(resolveBudget('minimal', injection, {}, {})).toBe(1024);
    expect(resolveBudget('high', injection, {}, {})).toBe(16384);
  });
});
