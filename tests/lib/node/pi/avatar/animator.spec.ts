/**
 * Tests for lib/node/pi/avatar/animator.ts.
 */

import { describe, expect, test } from 'vitest';

import { randomInRange, stepPingPong } from '../../../../../lib/node/pi/avatar/animator.ts';

describe('randomInRange', () => {
  test('maps the RNG range onto [min, max)', () => {
    expect(randomInRange(10, 20, () => 0)).toBe(10);
    expect(randomInRange(10, 20, () => 0.5)).toBe(15);
    expect(randomInRange(10, 20, () => 0.999)).toBeCloseTo(19.99, 5);
  });

  test('defaults to Math.random and stays within bounds', () => {
    for (let i = 0; i < 50; i++) {
      const value = randomInRange(3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThan(7);
    }
  });

  test('collapses a reversed or degenerate range to min (never samples backwards)', () => {
    // A reversed pair would otherwise map rng=0.5 to 15 (below min) - clamp to min.
    expect(randomInRange(20, 10, () => 0.5)).toBe(20);
    expect(randomInRange(5, 5, () => 0.9)).toBe(5);
  });
});

describe('stepPingPong', () => {
  test('bounces across a 3-frame state (0 -> 1 -> 2 -> 1 -> 0 -> 1 ...)', () => {
    const count = 3;
    let index = 0;
    let dir = 1;
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      const next = stepPingPong(index, dir, count);
      index = next.index;
      dir = next.dir;
      seen.push(index);
    }
    expect(seen).toEqual([1, 2, 1, 0, 1, 2, 1, 0]);
  });

  test('flips direction to -1 upon reaching the last frame', () => {
    expect(stepPingPong(1, 1, 3)).toEqual({ index: 2, dir: -1 });
  });

  test('flips direction to +1 upon reaching the first frame', () => {
    expect(stepPingPong(1, -1, 3)).toEqual({ index: 0, dir: 1 });
  });

  test('clamps a step past the last frame back to the last index (never count)', () => {
    // From the last frame stepping forward would land on `count` (3) - a
    // missing frame. Clamp to count-1 and flip direction.
    expect(stepPingPong(2, 1, 3)).toEqual({ index: 2, dir: -1 });
  });

  test('clamps a step below the first frame back to 0 (never -1)', () => {
    expect(stepPingPong(0, -1, 3)).toEqual({ index: 0, dir: 1 });
  });

  test('a 2-frame state alternates between 0 and 1', () => {
    const count = 2;
    let index = 0;
    let dir = 1;
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const next = stepPingPong(index, dir, count);
      index = next.index;
      dir = next.dir;
      seen.push(index);
    }
    expect(seen).toEqual([1, 0, 1, 0]);
  });
});
