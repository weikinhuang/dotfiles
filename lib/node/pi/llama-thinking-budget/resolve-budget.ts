/**
 * Budget resolution for the `llama-thinking-budget` extension: read the
 * `PI_LLAMA_BUDGET_*` env overrides and pick the effective numeric budget
 * for a level across the env / provider / settings / built-in layers.
 *
 * `env` is injected so resolution is deterministic and unit-testable; the
 * shell passes `process.env`.
 *
 * No pi imports.
 */

import { parseOptionalPositiveInt } from '../parse-env.ts';

import { DEFAULT_BUDGETS, type InjectionConfig, type Level } from './types.ts';

/**
 * Read the `PI_LLAMA_BUDGET_{MINIMAL,LOW,MEDIUM,HIGH}` overrides from `env`.
 * A missing / invalid value leaves the level `undefined` so a lower layer
 * can supply it.
 */
export function envBudgets(env: NodeJS.ProcessEnv): Partial<Record<Level, number>> {
  return {
    minimal: parseOptionalPositiveInt(env.PI_LLAMA_BUDGET_MINIMAL),
    low: parseOptionalPositiveInt(env.PI_LLAMA_BUDGET_LOW),
    medium: parseOptionalPositiveInt(env.PI_LLAMA_BUDGET_MEDIUM),
    high: parseOptionalPositiveInt(env.PI_LLAMA_BUDGET_HIGH),
  };
}

/**
 * Resolve the numeric budget for `level` in priority order: env override,
 * then the provider's per-level budget, then pi's `thinkingBudgets`
 * setting, then the built-in {@link DEFAULT_BUDGETS} fallback.
 */
export function resolveBudget(
  level: Level,
  injection: InjectionConfig,
  settings: Partial<Record<Level, number>>,
  env: Partial<Record<Level, number>>,
): number {
  return env[level] ?? injection.budgets[level] ?? settings[level] ?? DEFAULT_BUDGETS[level];
}
