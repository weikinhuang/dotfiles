/**
 * Shared types and constants for the `llama-thinking-budget` extension's
 * pure helpers. No pi imports - directly unit-testable.
 */

/** The four thinking levels pi exposes, low to high effort. */
export type Level = 'minimal' | 'low' | 'medium' | 'high';

/** Canonical ordered list of the thinking {@link Level}s. */
export const LEVELS: readonly Level[] = ['minimal', 'low', 'medium', 'high'] as const;

/**
 * pi-ai's built-in per-level budgets, used as the lowest-priority
 * fallback when neither env, provider config, nor settings supply one.
 */
export const DEFAULT_BUDGETS: Record<Level, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
};

/** A provider's opt-in `thinkingBudgetInjection` block, validated. */
export interface InjectionConfig {
  field: string;
  stripEffort: boolean;
  models?: Set<string>;
  budgets: Partial<Record<Level, number>>;
}
