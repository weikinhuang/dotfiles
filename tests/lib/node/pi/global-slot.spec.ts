/**
 * Tests for `lib/node/pi/global-slot.ts`.
 *
 * The helper exists to share state across the multiple jiti'd module
 * copies pi's extension loader produces. We exercise the contract here
 * without involving pi itself: two `createGlobalSlot` calls with the
 * same key must produce the same slot identity; different keys must be
 * isolated; `init` runs at most once per process.
 */

import { describe, expect, test } from 'vitest';

import { createGlobalSlot } from '../../../../lib/node/pi/global-slot.ts';

describe('createGlobalSlot', () => {
  test('returns the same slot identity across two getters with the same key', () => {
    const key = `@dotfiles/test/global-slot/${Math.random().toString(36).slice(2)}`;
    interface Slot {
      n: number;
    }
    const getA = createGlobalSlot<Slot>(key, () => ({ n: 0 }));
    const getB = createGlobalSlot<Slot>(key, () => ({ n: 999 }));
    getA().n = 7;
    // Second getter sees the same object — init only runs once.
    expect(getB().n).toBe(7);
    expect(getA()).toBe(getB());
  });

  test('different keys produce different slots', () => {
    const k1 = `@dotfiles/test/global-slot/${Math.random().toString(36).slice(2)}`;
    const k2 = `@dotfiles/test/global-slot/${Math.random().toString(36).slice(2)}`;
    const g1 = createGlobalSlot<{ v: string }>(k1, () => ({ v: 'one' }));
    const g2 = createGlobalSlot<{ v: string }>(k2, () => ({ v: 'two' }));
    expect(g1().v).toBe('one');
    expect(g2().v).toBe('two');
    g1().v = 'mutated';
    expect(g2().v).toBe('two');
  });

  test('init runs at most once per key', () => {
    const key = `@dotfiles/test/global-slot/${Math.random().toString(36).slice(2)}`;
    let inits = 0;
    const get = createGlobalSlot<{ marker: number }>(key, () => {
      inits++;
      return { marker: inits };
    });
    get();
    get();
    get();
    expect(inits).toBe(1);
  });
});
