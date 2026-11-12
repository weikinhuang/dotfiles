/** Bounded, content-free status for the final full-prompt soft target. */
import { isRecord } from '../shared/guards.ts';

const REASONS = [
  'none',
  'no-feasible-tail',
  'recap-rejected',
  'recap-failed',
  'summarizer-unavailable',
  'sanitizer-unavailable',
  'coverage-unresolved',
  'exception',
  'projection-changed',
] as const;
export type RoleplayBudgetReason = (typeof REASONS)[number];

export interface RoleplayBudgetStatus {
  targetTokens: number;
  estimatedInputTokens: number;
  outcome: 'met' | 'unmet';
  reason: RoleplayBudgetReason;
}

export function createRoleplayBudgetStatus(
  targetTokens: number,
  estimatedInputTokens: number,
  reason: RoleplayBudgetReason = 'none',
): RoleplayBudgetStatus | null {
  if (
    !Number.isFinite(targetTokens) ||
    targetTokens <= 0 ||
    !Number.isFinite(estimatedInputTokens) ||
    estimatedInputTokens < 0
  )
    return null;
  const target = Math.floor(targetTokens);
  if (target < 1) return null;
  const estimate = Math.ceil(estimatedInputTokens);
  const met = estimate <= target;
  return {
    targetTokens: target,
    estimatedInputTokens: estimate,
    outcome: met ? 'met' : 'unmet',
    reason: met ? 'none' : reason === 'none' ? 'projection-changed' : reason,
  };
}

export function readRoleplayBudgetStatus(value: unknown): RoleplayBudgetStatus | null {
  if (!isRecord(value) || typeof value.targetTokens !== 'number' || typeof value.estimatedInputTokens !== 'number')
    return null;
  if (!['met', 'unmet'].includes(String(value.outcome)) || !REASONS.includes(value.reason as RoleplayBudgetReason))
    return null;
  const result = createRoleplayBudgetStatus(
    value.targetTokens,
    value.estimatedInputTokens,
    value.reason as RoleplayBudgetReason,
  );
  return result?.outcome === value.outcome ? result : null;
}
