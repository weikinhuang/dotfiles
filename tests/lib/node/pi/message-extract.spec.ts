/**
 * Tests for lib/node/pi/message-extract.ts.
 */

import { expect, test } from 'vitest';

import {
  extractAssistantMessageText,
  extractLastAssistantText,
  findLastAssistantMessage,
} from '../../../../lib/node/pi/message-extract.ts';

// ──────────────────────────────────────────────────────────────────────
// findLastAssistantMessage
// ──────────────────────────────────────────────────────────────────────

test('findLastAssistantMessage: returns the last assistant message', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'first', stopReason: 'end_turn' },
    { role: 'user', content: 'more' },
    { role: 'assistant', content: 'second', stopReason: 'aborted' },
  ];
  expect(findLastAssistantMessage(msgs)?.content).toBe('second');
  expect(findLastAssistantMessage(msgs)?.stopReason).toBe('aborted');
});

test('findLastAssistantMessage: undefined when no assistant message present', () => {
  expect(findLastAssistantMessage([{ role: 'user', content: 'x' }])).toBeUndefined();
});

test('findLastAssistantMessage: undefined for non-array inputs', () => {
  expect(findLastAssistantMessage(undefined)).toBeUndefined();
  // @ts-expect-error intentionally passing the wrong type
  expect(findLastAssistantMessage(null)).toBeUndefined();
  // @ts-expect-error intentionally passing the wrong type
  expect(findLastAssistantMessage('not-an-array')).toBeUndefined();
});

test('findLastAssistantMessage: undefined entries do not crash', () => {
  expect(findLastAssistantMessage([undefined, null, { role: 'assistant' }])?.role).toBe('assistant');
});

test('findLastAssistantMessage: can unwrap branch entries', () => {
  expect(
    findLastAssistantMessage(
      [{ message: { role: 'user', content: 'x' } }, { message: { role: 'assistant', content: 'y' } }],
      {
        unwrapMessage: true,
      },
    )?.content,
  ).toBe('y');
});

// ──────────────────────────────────────────────────────────────────────
// extractAssistantMessageText
// ──────────────────────────────────────────────────────────────────────

test('extractAssistantMessageText: supports custom joiner and trim', () => {
  expect(
    extractAssistantMessageText(
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '  one ' },
          { type: 'text', text: 'two  ' },
        ],
      },
      { joiner: '', trim: true },
    ),
  ).toBe('one two');
});

// ──────────────────────────────────────────────────────────────────────
// extractLastAssistantText
// ──────────────────────────────────────────────────────────────────────

test('extractLastAssistantText: string content is returned verbatim', () => {
  expect(extractLastAssistantText([{ role: 'assistant', content: 'hello' }])).toBe('hello');
});

test('extractLastAssistantText: content-part array joins text parts with newlines', () => {
  const msgs = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'one' },
        { type: 'tool_use', name: 'bash', input: {} },
        { type: 'text', text: 'two' },
      ],
    },
  ];
  expect(extractLastAssistantText(msgs)).toBe('one\ntwo');
});

test('extractLastAssistantText: can stop on aborted assistant messages', () => {
  expect(
    extractLastAssistantText([{ role: 'assistant', content: 'partial', stopReason: 'aborted' }], {
      stopOnAborted: true,
    }),
  ).toBe('');
});

test('extractLastAssistantText: ignores non-text parts and missing text fields', () => {
  const msgs = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'bash' }, { type: 'text' }, null],
    },
  ];
  expect(extractLastAssistantText(msgs)).toBe('');
});

test('extractLastAssistantText: empty string when no assistant message', () => {
  expect(extractLastAssistantText([{ role: 'user', content: 'x' }])).toBe('');
  expect(extractLastAssistantText([])).toBe('');
  expect(extractLastAssistantText(undefined)).toBe('');
});

test('extractLastAssistantText: only the MOST RECENT assistant message is used', () => {
  const msgs = [
    { role: 'assistant', content: 'old' },
    { role: 'user', content: 'mid' },
    { role: 'assistant', content: 'new' },
  ];
  expect(extractLastAssistantText(msgs)).toBe('new');
});

test('extractLastAssistantText: unrecognized content shape returns empty string', () => {
  expect(extractLastAssistantText([{ role: 'assistant', content: 42 }])).toBe('');
});
