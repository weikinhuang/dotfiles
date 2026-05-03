/**
 * Tests for lib/node/pi/subagent-handle.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import { makeHandleCounter, resolveHandle } from '../../../../lib/node/pi/subagent-handle.ts';

describe('makeHandleCounter', () => {
  test('produces sub_<agent>_<n> with a monotonic counter', () => {
    const c = makeHandleCounter();

    expect(c.next('explore')).toBe('sub_explore_1');
    expect(c.next('plan')).toBe('sub_plan_2');
    expect(c.next('explore')).toBe('sub_explore_3');
  });

  test('reset restarts the counter at 1', () => {
    const c = makeHandleCounter();

    c.next('explore');
    c.next('explore');
    c.reset();

    expect(c.next('explore')).toBe('sub_explore_1');
  });
});

describe('resolveHandle', () => {
  test('looks up by canonical handle first', () => {
    const map = new Map<string, { childSessionId: string; marker: string }>([
      ['sub_explore_1', { childSessionId: 'child-abc', marker: 'A' }],
      ['sub_plan_2', { childSessionId: 'child-xyz', marker: 'B' }],
    ]);

    expect(resolveHandle('sub_explore_1', map)?.marker).toBe('A');
  });

  test('falls back to childSessionId if no handle matches', () => {
    const map = new Map<string, { childSessionId: string; marker: string }>([
      ['sub_plan_1', { childSessionId: 'child-xyz', marker: 'B' }],
    ]);

    expect(resolveHandle('child-xyz', map)?.marker).toBe('B');
  });

  test('returns undefined for empty / unknown input', () => {
    const map = new Map<string, { childSessionId: string }>();

    expect(resolveHandle('', map)).toBeUndefined();
    expect(resolveHandle('sub_explore_1', map)).toBeUndefined();
    expect(resolveHandle('unknown', map)).toBeUndefined();
  });

  test('handle lookup wins over a session id that happens to match a different entry', () => {
    const map = new Map<string, { childSessionId: string; marker: string }>([
      ['sub_explore_1', { childSessionId: 'child-a', marker: 'A' }],
      ['sub_plan_2', { childSessionId: 'sub_explore_1', marker: 'B' }],
    ]);

    expect(resolveHandle('sub_explore_1', map)?.marker).toBe('A');
  });
});
