/**
 * Pure parsers for the `llama-thinking-budget` config shapes: a per-level
 * budget map and a provider's `thinkingBudgetInjection` block. Untrusted
 * `unknown` in -> a validated structure out, dropping wrong-typed fields.
 *
 * No pi imports - directly unit-testable.
 */

import { parseOptionalPositiveInt } from '../parse-env.ts';

import { LEVELS, type InjectionConfig, type Level } from './types.ts';

/**
 * Parse a `{ minimal|low|medium|high: int }` budget map, keeping only the
 * levels that coerce to a positive integer. Non-object input yields `{}`.
 */
export function parseBudgets(raw: unknown): Partial<Record<Level, number>> {
  const out: Partial<Record<Level, number>> = {};
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const level of LEVELS) {
    const v = parseOptionalPositiveInt(obj[level]);
    if (v !== undefined) out[level] = v;
  }
  return out;
}

/**
 * Validate a provider's `thinkingBudgetInjection` block into an
 * {@link InjectionConfig}, applying defaults (`field`
 * = `thinking_budget_tokens`, `stripEffort` = false). Returns `undefined`
 * for a non-object input.
 */
export function parseInjection(raw: unknown): InjectionConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const field = typeof obj.field === 'string' && obj.field.trim() ? obj.field.trim() : 'thinking_budget_tokens';
  const stripEffort = obj.stripEffort === true;
  const models = Array.isArray(obj.models)
    ? new Set(obj.models.filter((m): m is string => typeof m === 'string' && m.length > 0))
    : undefined;
  const budgets = parseBudgets(obj.budgets);
  return { field, stripEffort, models, budgets };
}
