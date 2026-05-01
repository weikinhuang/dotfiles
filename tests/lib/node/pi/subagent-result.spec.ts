/**
 * Tests for lib/node/pi/subagent-result.ts.
 *
 * Pure module — no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';
import {
  type AgentMessageLike,
  classifyStopReason,
  extractFinalAssistantText,
} from '../../../../lib/node/pi/subagent-result.ts';

describe('extractFinalAssistantText', () => {
  test('returns empty string for missing / empty messages', () => {
    expect(extractFinalAssistantText(undefined)).toBe('');
    expect(extractFinalAssistantText([])).toBe('');
  });

  test('returns last assistant text parts, joined', () => {
    const msgs: AgentMessageLike[] = [
      { role: 'user', content: [{ type: 'text', text: 'go find X' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is ' },
          { type: 'text', text: 'the answer.' },
        ],
      },
    ];

    expect(extractFinalAssistantText(msgs)).toBe('Here is the answer.');
  });

  test('skips tool-call-only final assistant message, falls back to earlier text', () => {
    const msgs: AgentMessageLike[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'draft summary' }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] },
      { role: 'assistant', content: [{ type: 'toolCall' }] },
    ];

    expect(extractFinalAssistantText(msgs)).toBe('draft summary');
  });

  test('tool-call-only assistant with no prior text → empty', () => {
    const msgs: AgentMessageLike[] = [{ role: 'assistant', content: [{ type: 'toolCall' }] }];

    expect(extractFinalAssistantText(msgs)).toBe('');
  });

  test('drops empty text parts and non-text parts', () => {
    const msgs: AgentMessageLike[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'hidden' },
          { type: 'text', text: '' },
          { type: 'text', text: 'final' },
        ],
      },
    ];

    expect(extractFinalAssistantText(msgs)).toBe('final');
  });

  test('trims whitespace around final text', () => {
    const msgs: AgentMessageLike[] = [
      { role: 'assistant', content: [{ type: 'text', text: '   \n\n  Hello world\n\n' }] },
    ];

    expect(extractFinalAssistantText(msgs)).toBe('Hello world');
  });
});

describe('classifyStopReason', () => {
  test('default case is "completed"', () => {
    expect(classifyStopReason({})).toBe('completed');
  });

  test('max_turns wins over aborted + error', () => {
    expect(classifyStopReason({ reachedMaxTurns: true, aborted: true, error: true })).toBe('max_turns');
  });

  test('aborted wins over error', () => {
    expect(classifyStopReason({ aborted: true, error: true })).toBe('aborted');
  });

  test('error lands last before completed', () => {
    expect(classifyStopReason({ error: true })).toBe('error');
  });
});
