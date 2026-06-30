/**
 * Tests for lib/node/pi/memory-capture.ts.
 *
 * Pure module - the should-nudge predicate is a function of an
 * injected closure-state snapshot, so tests just pass shapes.
 */

import { describe, expect, test } from 'vitest';

import { CAPTURE_NUDGE, type CaptureNudgeState, shouldNudgeCapture } from '../../../../lib/node/pi/memory-capture.ts';

const base: CaptureNudgeState = { userTurnsSinceLastSave: 0, readOnly: false, disabled: false };

describe('shouldNudgeCapture', () => {
  test('nudges when there is user activity since the last save', () => {
    expect(shouldNudgeCapture({ ...base, userTurnsSinceLastSave: 1 })).toBe(true);
    expect(shouldNudgeCapture({ ...base, userTurnsSinceLastSave: 5 })).toBe(true);
  });

  test('stays quiet when nothing has happened since the last save', () => {
    expect(shouldNudgeCapture({ ...base, userTurnsSinceLastSave: 0 })).toBe(false);
  });

  test('stays quiet when read-only even with user activity', () => {
    expect(shouldNudgeCapture({ ...base, userTurnsSinceLastSave: 3, readOnly: true })).toBe(false);
  });

  test('stays quiet when disabled even with user activity', () => {
    expect(shouldNudgeCapture({ ...base, userTurnsSinceLastSave: 3, disabled: true })).toBe(false);
  });

  test('disabled and read-only both suppress regardless of activity', () => {
    expect(shouldNudgeCapture({ userTurnsSinceLastSave: 9, readOnly: true, disabled: true })).toBe(false);
  });
});

describe('CAPTURE_NUDGE', () => {
  test('is a non-empty, stable timing reminder', () => {
    expect(typeof CAPTURE_NUDGE).toBe('string');
    expect(CAPTURE_NUDGE.length).toBeGreaterThan(0);
    expect(CAPTURE_NUDGE).toContain('compact');
    expect(CAPTURE_NUDGE).toContain('memory save');
  });
});
