import { expect, test } from 'vitest';
import {
  createRoleplayBudgetStatus,
  readRoleplayBudgetStatus,
} from '../../../../../lib/node/pi/roleplay/budget-status.ts';

test('budget status separates soft compliance from physical fit and rounds consistently', () => {
  expect(createRoleplayBudgetStatus(70000, 74183, 'recap-rejected')).toEqual({
    targetTokens: 70000,
    estimatedInputTokens: 74183,
    outcome: 'unmet',
    reason: 'recap-rejected',
  });
  expect(createRoleplayBudgetStatus(70000, 69999.1, 'recap-failed')).toEqual({
    targetTokens: 70000,
    estimatedInputTokens: 70000,
    outcome: 'met',
    reason: 'none',
  });
  expect(createRoleplayBudgetStatus(10.9, 10.1)?.outcome).toBe('unmet');
  expect(createRoleplayBudgetStatus(0, 100)).toBeNull();
  expect(createRoleplayBudgetStatus(Number.NaN, 100)).toBeNull();
  expect(createRoleplayBudgetStatus(100, Number.POSITIVE_INFINITY)).toBeNull();
});

test('budget metadata roundtrips counts and enums without arbitrary text', () => {
  const status = createRoleplayBudgetStatus(70000, 74183, 'no-feasible-tail');
  expect(readRoleplayBudgetStatus({ ...status, error: 'PRIVATE_PROMPT' })).toEqual(status);
  expect(readRoleplayBudgetStatus({ ...status, reason: 'PRIVATE_PROMPT' })).toBeNull();
  expect(readRoleplayBudgetStatus({ ...status, outcome: 'met' })).toBeNull();
  expect(readRoleplayBudgetStatus({ ...status, estimatedInputTokens: -1 })).toBeNull();
});
