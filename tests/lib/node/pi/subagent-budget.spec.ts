/**
 * Tests for lib/node/pi/subagent-budget.ts.
 *
 * Locks the resolution semantics from
 * `plans/pi-subagent-overrides.md` decision D3:
 *   - Per-call override replaces the agent default.
 *   - PI_SUBAGENT_MAX_TURNS (envCap) always wins as the operator brake.
 *   - The helper itself does no validation - TypeBox at the schema
 *     layer enforces minimum/maximum bounds.
 */

import { describe, expect, test } from 'vitest';

import { resolveMaxTurns } from '../../../../lib/node/pi/subagent-budget.ts';

const UNCAPPED = Number.MAX_SAFE_INTEGER;

describe('resolveMaxTurns', () => {
  test('override unset, env unset → returns agentDefault', () => {
    expect(resolveMaxTurns({ override: undefined, agentDefault: 20, envCap: UNCAPPED })).toBe(20);
  });

  test('override above default, env unset → override wins (the new behaviour)', () => {
    expect(resolveMaxTurns({ override: 60, agentDefault: 20, envCap: UNCAPPED })).toBe(60);
  });

  test('override below default, env unset → override wins (lowering allowed)', () => {
    expect(resolveMaxTurns({ override: 5, agentDefault: 20, envCap: UNCAPPED })).toBe(5);
  });

  test('env cap below override → env wins (operator brake)', () => {
    expect(resolveMaxTurns({ override: 60, agentDefault: 20, envCap: 10 })).toBe(10);
  });

  test('env cap below default, override unset → env wins (existing behaviour preserved)', () => {
    expect(resolveMaxTurns({ override: undefined, agentDefault: 20, envCap: 10 })).toBe(10);
  });

  test('override = 0 → returns 0 (helper does not validate; TypeBox does)', () => {
    expect(resolveMaxTurns({ override: 0, agentDefault: 20, envCap: UNCAPPED })).toBe(0);
  });
});
