/**
 * Tests for lib/node/pi/secret-redactor/context-walk.ts.
 *
 * Pure module - no pi runtime. These pin down WHICH message fields the
 * `context` hook rewrites (user string content, `text` / `thinking`
 * parts on user / assistant / toolResult messages) and that the walk
 * mutates in place and reports whether anything changed.
 */

import { describe, expect, test, vi } from 'vitest';

import { redactMessages } from '../../../../../lib/node/pi/secret-redactor/context-walk.ts';

/** Uppercasing stand-in for the memoized `redactText` wrapper. */
const upper = (t: string): string => t.toUpperCase();
/** Identity redactor: never changes anything. */
const identity = (t: string): string => t;

describe('redactMessages', () => {
  test('redacts a user message with string content in place', () => {
    const messages = [{ role: 'user', content: 'secret' }];
    const changed = redactMessages(messages, upper);

    expect(changed).toBe(true);
    expect(messages[0].content).toBe('SECRET');
  });

  test('redacts `text` parts of a user message with array content', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', url: 'x' },
        ],
      },
    ];
    const changed = redactMessages(messages, upper);

    expect(changed).toBe(true);
    expect((messages[0].content as { text?: string }[])[0].text).toBe('HI');
    // Non-text parts are untouched.
    expect((messages[0].content as { url?: string }[])[1].url).toBe('x');
  });

  test('redacts `text` and `thinking` parts of an assistant message', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'reasoning' },
        ],
      },
    ];
    redactMessages(messages, upper);

    expect((messages[0].content as { text?: string }[])[0].text).toBe('ANSWER');
    expect((messages[0].content as { thinking?: string }[])[1].thinking).toBe('REASONING');
  });

  test('redacts toolResult array parts', () => {
    const messages = [{ role: 'toolResult', content: [{ type: 'text', text: 'out' }] }];
    redactMessages(messages, upper);

    expect((messages[0].content as { text?: string }[])[0].text).toBe('OUT');
  });

  test('returns false and mutates nothing when the redactor makes no change', () => {
    const messages = [{ role: 'user', content: 'unchanged' }];
    const changed = redactMessages(messages, identity);

    expect(changed).toBe(false);
    expect(messages[0].content).toBe('unchanged');
  });

  test('ignores assistant / toolResult messages with non-array content', () => {
    const redact = vi.fn(upper);
    const messages = [
      { role: 'assistant', content: 'string-not-array' },
      { role: 'system', content: 'nope' },
      null,
      42,
    ];
    const changed = redactMessages(messages, redact);

    expect(changed).toBe(false);
    // A string on an assistant message is NOT model-bound-text for this walk.
    expect(redact).not.toHaveBeenCalled();
  });

  test('reports changed=true if ANY message changes', () => {
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'string' },
    ];
    expect(redactMessages(messages, upper)).toBe(true);
  });
});
