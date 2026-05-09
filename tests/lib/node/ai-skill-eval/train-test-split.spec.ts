// SPDX-License-Identifier: MIT
import { describe, expect, test } from 'vitest';

import {
  mulberry32,
  shuffle,
  stratifiedSplit,
  type StratifiableItem,
} from '../../../../lib/node/ai-skill-eval/train-test-split.ts';

interface Q extends StratifiableItem {
  id: string;
  should_trigger: boolean;
}

function fixture(size: number, trueCount: number): Q[] {
  const out: Q[] = [];
  for (let i = 0; i < trueCount; i += 1) out.push({ id: `pos-${i}`, should_trigger: true });
  for (let i = 0; i < size - trueCount; i += 1) out.push({ id: `neg-${i}`, should_trigger: false });
  return out;
}

describe('mulberry32', () => {
  test('is deterministic per seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 20; i += 1) expect(a()).toBe(b());
  });

  test('produces different streams for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const firstA = a();
    const firstB = b();

    expect(firstA).not.toBe(firstB);
  });

  test('returns values in [0, 1)', () => {
    const r = mulberry32(99);
    for (let i = 0; i < 100; i += 1) {
      const v = r();

      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('shuffle', () => {
  test('preserves the multiset of elements', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffle(input, mulberry32(7));

    expect(out.slice().sort()).toStrictEqual(input.slice().sort());
  });

  test('does not mutate the input array', () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = input.slice();
    shuffle(input, mulberry32(11));

    expect(input).toStrictEqual(snapshot);
  });

  test('is deterministic for a given seed', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = shuffle(input, mulberry32(13));
    const b = shuffle(input, mulberry32(13));

    expect(a).toStrictEqual(b);
  });
});

describe('stratifiedSplit', () => {
  test('holdout=0 returns everything in train', () => {
    const items = fixture(10, 5);
    const r = stratifiedSplit(items, 0);

    expect(r.train.length).toBe(10);
    expect(r.test.length).toBe(0);
  });

  test('stratifies both classes into the test set', () => {
    const items = fixture(20, 10);
    const r = stratifiedSplit(items, 0.4);
    const testTrue = r.test.filter((i) => i.should_trigger).length;
    const testFalse = r.test.filter((i) => !i.should_trigger).length;

    expect(testTrue).toBe(4); // floor(10 * 0.4)
    expect(testFalse).toBe(4);
    expect(r.train.length).toBe(12);
  });

  test('always lifts at least one item per class into test when holdout > 0', () => {
    const items: Q[] = [
      { id: 'p', should_trigger: true },
      { id: 'n', should_trigger: false },
    ];
    const r = stratifiedSplit(items, 0.1); // floor(1 * 0.1) = 0 → max(1, 0) = 1

    expect(r.test.length).toBe(2);
    expect(r.train.length).toBe(0);
  });

  test('is deterministic for the same seed', () => {
    const items = fixture(40, 20);
    const a = stratifiedSplit(items, 0.4, 123);
    const b = stratifiedSplit(items, 0.4, 123);

    expect(a.train.map((x) => x.id)).toStrictEqual(b.train.map((x) => x.id));
    expect(a.test.map((x) => x.id)).toStrictEqual(b.test.map((x) => x.id));
  });

  test('produces different splits for different seeds', () => {
    const items = fixture(40, 20);
    const a = stratifiedSplit(items, 0.4, 1);
    const b = stratifiedSplit(items, 0.4, 2);

    // Unlikely (but not impossible) to be identical; assert on the train order.
    expect(a.train.map((x) => x.id)).not.toStrictEqual(b.train.map((x) => x.id));
  });

  test('never places an item in both train and test', () => {
    const items = fixture(30, 15);
    const r = stratifiedSplit(items, 0.3);
    const overlap = new Set(r.train.map((x) => x.id));
    for (const t of r.test) expect(overlap.has(t.id)).toBe(false);

    expect(r.train.length + r.test.length).toBe(items.length);
  });
});
