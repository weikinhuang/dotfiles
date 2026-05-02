/**
 * Tests for lib/node/pi/research-stuck.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  isStuck,
  isStuckShape,
  STUCK_STATUS,
  type Stuck,
  stuck,
} from '../../../../lib/node/pi/research-stuck.ts';

describe('stuck()', () => {
  test('constructs a canonical Stuck value', () => {
    expect(stuck('need a human')).toEqual({
      status: 'stuck',
      reason: 'need a human',
    });
  });

  test('trims leading/trailing whitespace in the reason', () => {
    expect(stuck('  spaced out  ')).toEqual({
      status: 'stuck',
      reason: 'spaced out',
    });
  });

  test('throws on an empty reason', () => {
    expect(() => stuck('')).toThrow(TypeError);
  });

  test('throws on a whitespace-only reason', () => {
    expect(() => stuck('   \t\n ')).toThrow(TypeError);
  });
});

describe('isStuckShape', () => {
  test('accepts a valid Stuck value', () => {
    expect(isStuckShape({ status: 'stuck', reason: 'why' })).toBe(true);
  });

  test('ignores extra fields (forward-compat)', () => {
    expect(isStuckShape({ status: 'stuck', reason: 'why', nextStep: 'ask' })).toBe(true);
  });

  test('rejects the wrong discriminator', () => {
    expect(isStuckShape({ status: 'ok', reason: 'why' })).toBe(false);
  });

  test('rejects a missing reason', () => {
    expect(isStuckShape({ status: 'stuck' })).toBe(false);
  });

  test('rejects an empty reason', () => {
    expect(isStuckShape({ status: 'stuck', reason: '' })).toBe(false);
  });

  test('rejects a whitespace-only reason', () => {
    expect(isStuckShape({ status: 'stuck', reason: '   ' })).toBe(false);
  });

  test('rejects non-string reason', () => {
    expect(isStuckShape({ status: 'stuck', reason: 42 })).toBe(false);
    expect(isStuckShape({ status: 'stuck', reason: null })).toBe(false);
  });

  test('rejects non-object inputs', () => {
    expect(isStuckShape(null)).toBe(false);
    expect(isStuckShape(undefined)).toBe(false);
    expect(isStuckShape('stuck')).toBe(false);
    expect(isStuckShape(0)).toBe(false);
    expect(isStuckShape([])).toBe(false);
  });
});

describe('isStuck (type guard for unions)', () => {
  interface Finding {
    id: string;
    body: string;
  }

  test('narrows Stuck | Finding to Stuck', () => {
    const v: Stuck | Finding = { status: 'stuck', reason: 'no signal' };

    expect(isStuck(v)).toBe(true);
    // TS narrows `v` to `Stuck` on assignment (contextual typing on
    // the object literal), so `.reason` reads without a cast. If a
    // future change loses that narrowing, the line below stops
    // compiling, which is the correct signal.
    expect(v.reason).toBe('no signal');
  });

  test('rejects a non-Stuck member of the union', () => {
    const v: Stuck | Finding = { id: 'f-1', body: 'ok' };

    expect(isStuck(v)).toBe(false);
  });

  test('rejects lookalike objects that fail shape validation', () => {
    interface LookAlike {
      status: string;
      reason: number;
    }
    const v: Stuck | LookAlike = { status: 'stuck', reason: 123 };

    expect(isStuck(v)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Failure modes + invariants.
// ──────────────────────────────────────────────────────────────────────

describe('Stuck — failure modes', () => {
  test('STUCK_STATUS is exactly the literal string "stuck"', () => {
    expect(STUCK_STATUS).toBe('stuck');
  });

  test('a deeply malformed payload from a model is rejected', () => {
    const bad: unknown = { status: 'Stuck', reason: 'case mismatch' };

    expect(isStuckShape(bad)).toBe(false);
  });

  test('array input is never a Stuck', () => {
    expect(isStuckShape(['stuck', 'why'])).toBe(false);
  });
});
