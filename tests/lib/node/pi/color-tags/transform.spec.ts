/**
 * Tests for lib/node/pi/color-tags/transform.ts.
 */

import { describe, expect, test } from 'vitest';

import { CLOSE_FG, ESC } from '../../../../../lib/node/pi/color-tags/resolve-color.ts';
import type { ColorResolver } from '../../../../../lib/node/pi/color-tags/parse-color-tags.ts';
import {
  applyToMessage,
  type MutableContextMessage,
  type MutableMessage,
  scrubContextMessages,
} from '../../../../../lib/node/pi/color-tags/transform.ts';

const redResolver: ColorResolver = (name) =>
  name.trim() === 'red' ? { open: `${ESC}[31m`, close: CLOSE_FG } : undefined;

describe('applyToMessage', () => {
  test('rewrites color tags in assistant text parts in place', () => {
    const message: MutableMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'a [c:red]b[/c] c' }],
    };
    const original = message.content?.[0];
    applyToMessage(message, redResolver);
    expect(message.content?.[0].text).toBe(`a ${ESC}[31mb${CLOSE_FG} c`);
    // mutated in place: same object reference.
    expect(message.content?.[0]).toBe(original);
  });

  test('rewrites thinking parts too', () => {
    const message: MutableMessage = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '[c:red]hmm[/c]' }],
    };
    applyToMessage(message, redResolver);
    expect(message.content?.[0].thinking).toBe(`${ESC}[31mhmm${CLOSE_FG}`);
  });

  test('non-assistant messages are left untouched', () => {
    const message: MutableMessage = {
      role: 'user',
      content: [{ type: 'text', text: '[c:red]b[/c]' }],
    };
    applyToMessage(message, redResolver);
    expect(message.content?.[0].text).toBe('[c:red]b[/c]');
  });

  test('a message without a content array is a no-op', () => {
    const message: MutableMessage = { role: 'assistant' };
    expect(() => applyToMessage(message, redResolver)).not.toThrow();
  });
});

describe('scrubContextMessages', () => {
  test('strips ANSI from assistant parts and returns a new copy', () => {
    const messages: MutableContextMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: `${ESC}[31mred${ESC}[39m` }] },
    ];
    const result = scrubContextMessages(messages);
    expect(result).toBeDefined();
    expect(result?.messages[0].content?.[0].text).toBe('red');
    // original left unmutated.
    expect(messages[0].content?.[0].text).toBe(`${ESC}[31mred${ESC}[39m`);
  });

  test('returns undefined when no assistant part contains ANSI', () => {
    const messages: MutableContextMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'plain' }] },
      { role: 'user', content: [{ type: 'text', text: `${ESC}[31mignored${ESC}[39m` }] },
    ];
    expect(scrubContextMessages(messages)).toBeUndefined();
  });

  test('unchanged messages keep their original reference', () => {
    const clean = { role: 'assistant', content: [{ type: 'text', text: 'clean' }] };
    const dirty = { role: 'assistant', content: [{ type: 'text', text: `${ESC}[31mx${ESC}[39m` }] };
    const result = scrubContextMessages([clean, dirty]);
    expect(result?.messages[0]).toBe(clean);
    expect(result?.messages[1]).not.toBe(dirty);
  });

  test('scrubs thinking parts as well', () => {
    const messages: MutableContextMessage[] = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: `${ESC}[32mok${ESC}[39m` }] },
    ];
    const result = scrubContextMessages(messages);
    expect(result?.messages[0].content?.[0].thinking).toBe('ok');
  });
});
