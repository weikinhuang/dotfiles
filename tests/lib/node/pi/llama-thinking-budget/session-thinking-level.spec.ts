/**
 * Tests for lib/node/pi/llama-thinking-budget/session-thinking-level.ts.
 */

import { describe, expect, test } from 'vitest';

import { resolveThinkingLevel } from '../../../../../lib/node/pi/llama-thinking-budget/session-thinking-level.ts';

describe('resolveThinkingLevel', () => {
  test('returns the most recent thinking_level_change level', () => {
    const branch = [
      { type: 'thinking_level_change', thinkingLevel: 'low' },
      { type: 'message' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
    ];
    expect(resolveThinkingLevel(branch)).toBe('high');
  });

  test('clamps xhigh to high, mirroring pi-ai', () => {
    expect(resolveThinkingLevel([{ type: 'thinking_level_change', thinkingLevel: 'xhigh' }])).toBe('high');
  });

  test('returns undefined when no thinking_level_change entry exists', () => {
    expect(resolveThinkingLevel([{ type: 'message' }, { type: 'tool_result' }])).toBeUndefined();
    expect(resolveThinkingLevel([])).toBeUndefined();
  });

  test('returns undefined when the latest level is missing or unrecognized', () => {
    expect(resolveThinkingLevel([{ type: 'thinking_level_change' }])).toBeUndefined();
    expect(resolveThinkingLevel([{ type: 'thinking_level_change', thinkingLevel: 'bogus' }])).toBeUndefined();
  });

  test('stops at the first match from the end, ignoring older entries', () => {
    const branch = [
      { type: 'thinking_level_change', thinkingLevel: 'medium' },
      { type: 'thinking_level_change', thinkingLevel: 'bogus' },
    ];
    expect(resolveThinkingLevel(branch)).toBeUndefined();
  });
});
