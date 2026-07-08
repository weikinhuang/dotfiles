/**
 * Tests for lib/node/pi/message-text.ts.
 */

import { expect, test } from 'vitest';

import {
  collectRoleMessageTexts,
  concatRecentMessageText,
  latestMessageTextFromEntries,
  messageContentToText,
} from '../../../../lib/node/pi/message-text.ts';

const textPart = (text: string): unknown => ({ type: 'text', text });

test('messageContentToText: string content returned as-is', () => {
  expect(messageContentToText('hello')).toBe('hello');
});

test('messageContentToText: array joins text parts with the separator', () => {
  expect(messageContentToText([textPart('a'), { type: 'image' }, textPart('b')])).toBe('a\nb');
  expect(messageContentToText([textPart('a'), textPart('b')], ' ')).toBe('a b');
});

test('messageContentToText: non-string/non-array yields empty string', () => {
  expect(messageContentToText(undefined)).toBe('');
  expect(messageContentToText({ foo: 1 })).toBe('');
});

test('concatRecentMessageText: takes the last n messages, mixed content', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: [textPart('second'), textPart('third')] },
    { role: 'user', content: 'fourth' },
  ];
  expect(concatRecentMessageText(messages, 2)).toBe('second\nthird\nfourth');
  expect(concatRecentMessageText(messages, 10)).toBe('first\nsecond\nthird\nfourth');
});

test('concatRecentMessageText: n floors at 1', () => {
  const messages = [{ content: 'a' }, { content: 'b' }];
  expect(concatRecentMessageText(messages, 0)).toBe('b');
});

test('collectRoleMessageTexts: filters by role, skips empties, windows the tail', () => {
  const messages = [
    { role: 'assistant', content: 'one' },
    { role: 'user', content: 'ignored' },
    { role: 'assistant', content: '   ' },
    { role: 'assistant', content: [textPart('two'), textPart('three')] },
    { role: 'assistant', content: 'four' },
  ];
  expect(collectRoleMessageTexts(messages, { role: 'assistant', window: 2 })).toEqual(['two\nthree', 'four']);
  expect(collectRoleMessageTexts(messages, { role: 'assistant', window: 10 })).toEqual(['one', 'two\nthree', 'four']);
});

test('latestMessageTextFromEntries: returns the most recent matching message text', () => {
  const entries = [
    { type: 'message', message: { role: 'user', content: 'old' } },
    { type: 'message', message: { role: 'assistant', content: 'reply' } },
    { type: 'tool_result', message: { role: 'user', content: 'not a message entry' } },
    { type: 'message', message: { role: 'user', content: [textPart('new'), textPart('prompt')] } },
  ];
  expect(latestMessageTextFromEntries(entries)).toBe('new prompt');
  expect(latestMessageTextFromEntries(entries, { role: 'assistant' })).toBe('reply');
});

test('latestMessageTextFromEntries: skips non-string/array content and empty input', () => {
  const entries = [
    { type: 'message', message: { role: 'user', content: 'earlier' } },
    { type: 'message', message: { role: 'user', content: { weird: true } } },
  ];
  expect(latestMessageTextFromEntries(entries)).toBe('earlier');
  expect(latestMessageTextFromEntries([])).toBe('');
});
