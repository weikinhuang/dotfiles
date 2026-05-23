/**
 * Tests for lib/node/pi/btw/answer.ts.
 */

import { describe, expect, test } from 'vitest';

import { extractAnswerText } from '../../../../../lib/node/pi/btw/answer.ts';

describe('extractAnswerText', () => {
  test('joins consecutive text parts with no separator', () => {
    const out = extractAnswerText([
      { type: 'text', text: 'Hello, ' },
      { type: 'text', text: 'world.' },
    ]);

    expect(out).toBe('Hello, world.');
  });

  test('drops thinking parts', () => {
    const out = extractAnswerText([
      { type: 'thinking', text: 'hmm...' },
      { type: 'text', text: 'The answer is 42.' },
    ]);

    expect(out).toBe('The answer is 42.');
  });

  test('drops toolCall parts', () => {
    const out = extractAnswerText([
      { type: 'toolCall', text: '{ "name": "bash" }' },
      { type: 'text', text: 'done' },
    ]);

    expect(out).toBe('done');
  });

  test('trims the joined result', () => {
    const out = extractAnswerText([{ type: 'text', text: '  foo  \n' }]);

    expect(out).toBe('foo');
  });

  test('returns empty string for empty / missing content', () => {
    expect(extractAnswerText(undefined)).toBe('');
    expect(extractAnswerText([])).toBe('');
    expect(extractAnswerText([{ type: 'text' }])).toBe('');
    expect(extractAnswerText([{ type: 'text', text: '' }])).toBe('');
  });

  test('skips non-text parts even if they carry a text field', () => {
    const out = extractAnswerText([
      // pi-ai's ToolCall has `arguments`, not `text`, but a custom shape
      // could still carry `text`. Any non-"text" type is dropped.
      { type: 'weird', text: 'ignore me' },
      { type: 'text', text: 'keep me' },
    ]);

    expect(out).toBe('keep me');
  });
});
