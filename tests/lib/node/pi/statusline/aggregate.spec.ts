/**
 * Tests for lib/node/pi/statusline/aggregate.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { aggregate } from '../../../../../lib/node/pi/statusline/aggregate.ts';

const assistant = (usage: Record<string, unknown> | undefined, toolCalls = 0): Record<string, unknown> => ({
  type: 'message',
  message: {
    role: 'assistant',
    usage,
    content: Array.from({ length: toolCalls }, (): Record<string, unknown> => ({ type: 'toolCall' })),
  },
});

const user = (): Record<string, unknown> => ({
  type: 'message',
  message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
});

const toolResult = (text: string): Record<string, unknown> => ({
  type: 'message',
  message: { role: 'toolResult', content: [{ type: 'text', text }] },
});

test('returns a fully-zeroed result for a non-array branch', () => {
  const out = aggregate(undefined);
  expect(out).toEqual({
    sessionIn: 0,
    sessionCacheRead: 0,
    sessionCacheWrite: 0,
    sessionOut: 0,
    sessionCostTotal: 0,
    turns: 0,
    lastIn: 0,
    lastCacheRead: 0,
    lastCacheWrite: 0,
    lastOut: 0,
    toolCalls: 0,
    toolResultBytes: 0,
  });
});

test('sums session usage, keeps last-turn usage, counts turns/toolCalls/bytes', () => {
  const out = aggregate([
    user(),
    assistant({ input: 100, cacheRead: 50, cacheWrite: 10, output: 20, cost: { total: 0.5 } }, 2),
    toolResult('abcd'),
    user(),
    assistant({ input: 200, cacheRead: 60, cacheWrite: 5, output: 40, cost: { total: 0.25 } }, 1),
    toolResult('xy'),
  ]);

  expect(out.turns).toBe(2);
  expect(out.toolCalls).toBe(3);
  expect(out.toolResultBytes).toBe(6);
  // Session = sum across both assistant messages.
  expect(out.sessionIn).toBe(300);
  expect(out.sessionCacheRead).toBe(110);
  expect(out.sessionCacheWrite).toBe(15);
  expect(out.sessionOut).toBe(60);
  expect(out.sessionCostTotal).toBeCloseTo(0.75, 10);
  // Last = the most recent assistant message only.
  expect(out.lastIn).toBe(200);
  expect(out.lastCacheRead).toBe(60);
  expect(out.lastCacheWrite).toBe(5);
  expect(out.lastOut).toBe(40);
});

test('counts tool-result text as UTF-8 bytes, not UTF-16 code units', () => {
  // "é" is 2 UTF-8 bytes; "😀" is 4. `.length` would report 1 and 2 (surrogate
  // pair) respectively, undercounting - toolResultBytes must reflect bytes.
  const out = aggregate([toolResult('é😀')]);
  expect(out.toolResultBytes).toBe(6);
});

test('ignores non-message entries and assistant messages without usage', () => {
  const out = aggregate([{ type: 'custom' }, assistant(undefined, 1)]);
  expect(out.sessionIn).toBe(0);
  expect(out.toolCalls).toBe(1);
});
