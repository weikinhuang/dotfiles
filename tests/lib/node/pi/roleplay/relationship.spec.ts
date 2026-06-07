/**
 * Tests for the pure relationship-decay math (`relationship.ts`).
 */

import { expect, test } from 'vitest';

import {
  daysElapsed,
  decayAffinity,
  formatRelationshipLine,
} from '../../../../../lib/node/pi/roleplay/relationship.ts';

const NOW = new Date('2026-06-10T12:00:00Z');
const OPTS = { decayPerDay: 1, baseline: 50 };

test('daysElapsed counts whole days, rejecting missing/unparseable/future dates', () => {
  expect(daysElapsed('2026-06-07', NOW)).toBe(3);
  expect(daysElapsed('2026-06-10', NOW)).toBe(0); // same day (partial < 1 day floors to 0)
  expect(daysElapsed(undefined, NOW)).toBeNull();
  expect(daysElapsed('   ', NOW)).toBeNull();
  expect(daysElapsed('not-a-date', NOW)).toBeNull();
  expect(daysElapsed('2026-06-20', NOW)).toBeNull(); // future
});

test('decayAffinity erodes a high affinity toward the baseline', () => {
  // 80, 3 days idle, 1/day -> 77
  expect(decayAffinity({ affinity: 80, lastInteraction: '2026-06-07' }, NOW, OPTS)).toBe(77);
});

test('decayAffinity warms a low affinity up toward the baseline', () => {
  // 20, 3 days idle, 1/day -> 23
  expect(decayAffinity({ affinity: 20, lastInteraction: '2026-06-07' }, NOW, OPTS)).toBe(23);
});

test('decayAffinity never crosses the baseline', () => {
  // 52, 10 days idle at 1/day would reach 42, but stops at baseline 50
  expect(decayAffinity({ affinity: 52, lastInteraction: '2026-05-31' }, NOW, OPTS)).toBe(50);
  // 48 warming up stops at 50, not 58
  expect(decayAffinity({ affinity: 48, lastInteraction: '2026-05-31' }, NOW, OPTS)).toBe(50);
});

test('decayAffinity returns the stored value when no decay applies', () => {
  expect(decayAffinity({ affinity: 80, lastInteraction: undefined }, NOW, OPTS)).toBe(80);
  expect(decayAffinity({ affinity: 80, lastInteraction: '2026-06-10' }, NOW, OPTS)).toBe(80); // 0 days
  expect(decayAffinity({ affinity: 80, lastInteraction: '2026-06-07' }, NOW, { ...OPTS, decayPerDay: 0 })).toBe(80);
});

test('decayAffinity clamps the stored affinity into [0, 100] first', () => {
  expect(decayAffinity({ affinity: 250, lastInteraction: undefined }, NOW, OPTS)).toBe(100);
  expect(decayAffinity({ affinity: -9, lastInteraction: undefined }, NOW, OPTS)).toBe(0);
});

test('decayAffinity at the baseline never moves', () => {
  expect(decayAffinity({ affinity: 50, lastInteraction: '2026-05-01' }, NOW, OPTS)).toBe(50);
});

test('formatRelationshipLine shows drift parenthetical only when current differs', () => {
  expect(formatRelationshipLine(72, 72, 'high', 50)).toBe('affinity 72/100, trust: high');
  expect(formatRelationshipLine(72, 69, 'high', 50)).toBe('affinity 69/100 (stored 72, neutral 50), trust: high');
  expect(formatRelationshipLine(50, 50, '', 50)).toBe('affinity 50/100');
});
