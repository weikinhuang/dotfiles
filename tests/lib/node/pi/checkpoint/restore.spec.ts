/**
 * Tests for lib/node/pi/checkpoint/restore.ts.
 *
 * Pure module - selected targets → ordered write/delete plan. Pins the
 * write-vs-delete mapping (null target → delete), the carried blob hash,
 * and deterministic path ordering.
 */

import { describe, expect, test } from 'vitest';

import { buildRestorePlan } from '../../../../../lib/node/pi/checkpoint/restore.ts';
import type { FileTarget } from '../../../../../lib/node/pi/checkpoint/types.ts';

describe('buildRestorePlan', () => {
  test('non-null target → write carrying the blob hash', () => {
    const selected: FileTarget[] = [{ path: 'a.ts', target: 'h0', expectedCurrent: 'h2' }];
    expect(buildRestorePlan(selected)).toEqual([{ path: 'a.ts', kind: 'write', sha: 'h0' }]);
  });

  test('null target → delete', () => {
    const selected: FileTarget[] = [{ path: 'gone.ts', target: null, expectedCurrent: 'h2' }];
    expect(buildRestorePlan(selected)).toEqual([{ path: 'gone.ts', kind: 'delete' }]);
  });

  test('plan is sorted by path', () => {
    const selected: FileTarget[] = [
      { path: 'z.ts', target: 'h1', expectedCurrent: null },
      { path: 'a.ts', target: null, expectedCurrent: 'h2' },
    ];
    expect(buildRestorePlan(selected).map((a) => a.path)).toEqual(['a.ts', 'z.ts']);
  });

  test('empty selection → empty plan', () => {
    expect(buildRestorePlan([])).toEqual([]);
  });
});
