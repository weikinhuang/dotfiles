/**
 * Tests for lib/node/pi/hooks/reduce.ts.
 */

import { describe, expect, test } from 'vitest';

import { appendSystemPromptContext, appendToolResultContext } from '../../../../../lib/node/pi/hooks/reduce.ts';

describe('appendToolResultContext', () => {
  test('copies an existing content array and appends newline-prefixed text parts', () => {
    const content = [{ type: 'text', text: 'original' }];
    const next = appendToolResultContext(content, ['extra one', 'extra two']);
    expect(next).toEqual([
      { type: 'text', text: 'original' },
      { type: 'text', text: '\nextra one' },
      { type: 'text', text: '\nextra two' },
    ]);
  });

  test('does not mutate the input content array', () => {
    const content = [{ type: 'text', text: 'original' }];
    appendToolResultContext(content, ['extra']);
    expect(content).toEqual([{ type: 'text', text: 'original' }]);
  });

  test('non-array content starts a fresh array', () => {
    expect(appendToolResultContext(undefined, ['one'])).toEqual([{ type: 'text', text: '\none' }]);
    expect(appendToolResultContext('a string', ['one'])).toEqual([{ type: 'text', text: '\none' }]);
  });
});

describe('appendSystemPromptContext', () => {
  test('joins appended blocks with a blank line and separates from the base', () => {
    expect(appendSystemPromptContext('base prompt', ['a', 'b'])).toBe('base prompt\n\na\n\nb');
  });

  test('an empty base prompt returns the joined tail alone', () => {
    expect(appendSystemPromptContext('', ['a', 'b'])).toBe('a\n\nb');
  });

  test('a single appended block with a non-empty base', () => {
    expect(appendSystemPromptContext('base', ['only'])).toBe('base\n\nonly');
  });
});
