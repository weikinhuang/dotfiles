/**
 * Tests for lib/node/pi/context-edit/target.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import {
  findToolCall,
  type LooseMessage,
  resolveTarget,
  type Target,
  targetKey,
  targetsEqual,
  toParts,
} from '../../../../../lib/node/pi/context-edit/target.ts';

const userMsg = (text: string, ts: number): LooseMessage => ({ role: 'user', content: text, timestamp: ts });
const asstWithCall = (callId: string, ts: number): LooseMessage => ({
  role: 'assistant',
  content: [
    { type: 'text', text: 'calling' },
    { type: 'toolCall', id: callId, name: 'bash', arguments: { cmd: 'ls' } },
  ],
  timestamp: ts,
});
const toolResult = (callId: string, ts: number): LooseMessage => ({
  role: 'toolResult',
  toolCallId: callId,
  toolName: 'bash',
  content: [{ type: 'text', text: 'a\nb' }],
  timestamp: ts,
});

describe('targetKey / targetsEqual', () => {
  test('whole-message and part-scoped targets never collide', () => {
    const whole: Target = { by: 'message', role: 'user', timestamp: 5 };
    const part: Target = { by: 'message', role: 'user', timestamp: 5, partIndex: 0 };
    expect(targetKey(whole)).not.toBe(targetKey(part));
    expect(targetsEqual(whole, part)).toBe(false);
  });

  test('occurrence disambiguates same role+timestamp', () => {
    const a: Target = { by: 'message', role: 'user', timestamp: 5, occurrence: 0 };
    const b: Target = { by: 'message', role: 'user', timestamp: 5, occurrence: 1 };
    expect(targetsEqual(a, b)).toBe(false);
  });

  test('toolCallId targets equal by id + partIndex', () => {
    expect(targetsEqual({ by: 'toolCallId', toolCallId: 'x' }, { by: 'toolCallId', toolCallId: 'x' })).toBe(true);
    expect(targetsEqual({ by: 'toolCallId', toolCallId: 'x' }, { by: 'toolCallId', toolCallId: 'y' })).toBe(false);
  });
});

describe('toParts', () => {
  test('wraps a string into one text part', () => {
    expect(toParts('hi')).toEqual([{ type: 'text', text: 'hi' }]);
  });
  test('returns array content unchanged', () => {
    const parts = [{ type: 'text', text: 'a' }] as const;
    expect(toParts([...parts])).toEqual(parts);
  });
});

describe('resolveTarget', () => {
  const messages: LooseMessage[] = [userMsg('first', 100), userMsg('second', 200), toolResult('call-1', 300)];

  test('resolves a message target by role+timestamp', () => {
    expect(resolveTarget(messages, { by: 'message', role: 'user', timestamp: 200 })).toEqual({
      messageIndex: 1,
      partIndex: undefined,
    });
  });

  test('resolves a tool result by toolCallId', () => {
    expect(resolveTarget(messages, { by: 'toolCallId', toolCallId: 'call-1' })).toEqual({
      messageIndex: 2,
      partIndex: undefined,
    });
  });

  test('returns null for an unmatched target (stale)', () => {
    expect(resolveTarget(messages, { by: 'message', role: 'user', timestamp: 999 })).toBeNull();
    expect(resolveTarget(messages, { by: 'toolCallId', toolCallId: 'nope' })).toBeNull();
  });

  test('occurrence selects the Nth same role+timestamp message', () => {
    const dupes: LooseMessage[] = [userMsg('a', 5), userMsg('b', 5)];
    expect(resolveTarget(dupes, { by: 'message', role: 'user', timestamp: 5, occurrence: 0 })?.messageIndex).toBe(0);
    expect(resolveTarget(dupes, { by: 'message', role: 'user', timestamp: 5, occurrence: 1 })?.messageIndex).toBe(1);
  });
});

describe('findToolCall', () => {
  test('locates the assistant toolCall part by id', () => {
    const messages: LooseMessage[] = [userMsg('go', 1), asstWithCall('call-9', 2)];
    expect(findToolCall(messages, 'call-9')).toEqual({ messageIndex: 1, partIndex: 1 });
  });
  test('returns null when the call is absent', () => {
    expect(findToolCall([userMsg('go', 1)], 'missing')).toBeNull();
  });
});
