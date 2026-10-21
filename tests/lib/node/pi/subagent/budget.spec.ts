/**
 * Tests for lib/node/pi/subagent/budget.ts.
 *
 * Locks the resolution semantics from
 * `plans/pi-subagent-overrides.md` decision D3:
 *   - Per-call override replaces the agent default.
 *   - PI_SUBAGENT_MAX_TURNS (envCap) always wins as the operator brake.
 *   - The helper itself does no validation - TypeBox at the schema
 *     layer enforces minimum/maximum bounds.
 */

import { describe, expect, test } from 'vitest';

import { resolveMaxTurns, resolveTimeoutMs } from '../../../../../lib/node/pi/subagent/budget.ts';

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

describe('resolveTimeoutMs', () => {
  const HOUR = 3_600_000;

  test('no override → agent frontmatter default', () => {
    expect(
      resolveTimeoutMs({ override: undefined, agentDefault: 300_000, maxTimeoutMs: HOUR, hardCap: UNCAPPED }),
    ).toEqual({ timeoutMs: 300_000, clampedToCeiling: false });
  });

  test('per-call override lifts the cap above a 300 s agent default', () => {
    expect(
      resolveTimeoutMs({ override: 1_200_000, agentDefault: 300_000, maxTimeoutMs: HOUR, hardCap: UNCAPPED }),
    ).toEqual({ timeoutMs: 1_200_000, clampedToCeiling: false });
  });

  test('per-call override can also lower the cap', () => {
    expect(
      resolveTimeoutMs({ override: 60_000, agentDefault: 300_000, maxTimeoutMs: HOUR, hardCap: UNCAPPED }),
    ).toEqual({ timeoutMs: 60_000, clampedToCeiling: false });
  });

  test('per-call override above the ceiling is clamped and flagged', () => {
    expect(
      resolveTimeoutMs({ override: 2 * HOUR, agentDefault: 300_000, maxTimeoutMs: HOUR, hardCap: UNCAPPED }),
    ).toEqual({ timeoutMs: HOUR, clampedToCeiling: true });
  });

  test('the ceiling bounds per-call overrides only, not the agent default', () => {
    expect(
      resolveTimeoutMs({ override: undefined, agentDefault: 2 * HOUR, maxTimeoutMs: HOUR, hardCap: UNCAPPED }),
    ).toEqual({ timeoutMs: 2 * HOUR, clampedToCeiling: false });
  });

  test('PI_SUBAGENT_TIMEOUT_MS hard cap wins over everything', () => {
    expect(
      resolveTimeoutMs({ override: 1_200_000, agentDefault: 300_000, maxTimeoutMs: HOUR, hardCap: 90_000 }),
    ).toEqual({ timeoutMs: 90_000, clampedToCeiling: false });
    expect(
      resolveTimeoutMs({ override: undefined, agentDefault: 300_000, maxTimeoutMs: HOUR, hardCap: 90_000 }),
    ).toEqual({ timeoutMs: 90_000, clampedToCeiling: false });
  });
});
