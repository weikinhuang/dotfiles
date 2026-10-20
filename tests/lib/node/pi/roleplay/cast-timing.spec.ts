import { describe, expect, it } from 'vitest';

import {
  createCastTimingState,
  resetCastTiming,
  resetSceneFoldDelivery,
  type CastTimingState,
} from '../../../../../lib/node/pi/roleplay/cast-timing.ts';

function dirty(): CastTimingState {
  return {
    turnCount: 5,
    timingState: { a: { stickyUntil: 7, cooldownUntil: 0 } },
    sceneTimingState: { b: { stickyUntil: 0, cooldownUntil: 9 } },
    sceneFoldDelivered: new Map([['mira', 4]]),
    sceneFoldPriorActive: new Set(['mira']),
  };
}

describe('cast timing state', () => {
  it('creates a cold state', () => {
    expect(createCastTimingState()).toEqual({
      turnCount: 0,
      timingState: {},
      sceneTimingState: {},
      sceneFoldDelivered: new Map(),
      sceneFoldPriorActive: new Set(),
    });
  });

  it('resetCastTiming clears every field with fresh collections', () => {
    const t = dirty();
    const delivered = t.sceneFoldDelivered;
    resetCastTiming(t);
    expect(t).toEqual(createCastTimingState());
    expect(t.sceneFoldDelivered).not.toBe(delivered);
    expect(delivered.get('mira')).toBe(4);
  });

  it('resetSceneFoldDelivery keeps lorebook timing and the turn counter', () => {
    const t = dirty();
    resetSceneFoldDelivery(t);
    expect(t).toEqual({ ...dirty(), sceneFoldDelivered: new Map(), sceneFoldPriorActive: new Set() });
  });
});
