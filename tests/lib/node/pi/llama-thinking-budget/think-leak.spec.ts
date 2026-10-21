/**
 * Tests for lib/node/pi/llama-thinking-budget/think-leak.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { hasLeakedThinkTag, splitLeakedThinking } from '../../../../../lib/node/pi/llama-thinking-budget/think-leak.ts';

const LEAK =
  'Dark for three weeks. The lens cracked in a frost.\n</think>\n\nDark for three weeks. Lens cracked, lampkeeper walked.';

test('splitLeakedThinking returns undefined when no text part carries a think tag', () => {
  expect(splitLeakedThinking([{ type: 'text', text: 'plain reply' }])).toBeUndefined();
  expect(splitLeakedThinking([{ type: 'thinking', thinking: 'a </think> b' }])).toBeUndefined();
  expect(hasLeakedThinkTag([{ type: 'text', text: 'x' }])).toBe(false);
});

test('splitLeakedThinking moves the draft before the last </think> into a thinking part', () => {
  const out = splitLeakedThinking([
    { type: 'thinking', thinking: 'plan', thinkingSignature: 'reasoning_content' },
    { type: 'text', text: LEAK },
  ]);
  expect(out).toEqual([
    { type: 'thinking', thinking: 'plan', thinkingSignature: 'reasoning_content' },
    {
      type: 'thinking',
      thinking: 'Dark for three weeks. The lens cracked in a frost.',
      thinkingSignature: 'reasoning_content',
    },
    { type: 'text', text: 'Dark for three weeks. Lens cracked, lampkeeper walked.' },
  ]);
});

test('splitLeakedThinking strips a leading <think> opener and reuses an existing signature', () => {
  const out = splitLeakedThinking([
    { type: 'thinking', thinking: 'x', thinkingSignature: 'reasoning' },
    { type: 'text', text: '<think>draft</think>final' },
  ]);
  expect(out?.slice(1)).toEqual([
    { type: 'thinking', thinking: 'draft', thinkingSignature: 'reasoning' },
    { type: 'text', text: 'final' },
  ]);
});

test('splitLeakedThinking defaults the signature to reasoning_content', () => {
  expect(splitLeakedThinking([{ type: 'text', text: 'a</think>b' }])).toEqual([
    { type: 'thinking', thinking: 'a', thinkingSignature: 'reasoning_content' },
    { type: 'text', text: 'b' },
  ]);
});

test('splitLeakedThinking splits on the LAST closer when several leak', () => {
  expect(splitLeakedThinking([{ type: 'text', text: 'one</think>two</think>three' }])?.at(-1)).toEqual({
    type: 'text',
    text: 'three',
  });
});

test('splitLeakedThinking keeps the text visible when nothing follows the closer', () => {
  expect(splitLeakedThinking([{ type: 'text', text: 'only answer\n</think>\n' }])).toEqual([
    { type: 'text', text: 'only answer' },
  ]);
  expect(splitLeakedThinking([{ type: 'text', text: '<think>stray opener' }])).toEqual([
    { type: 'text', text: 'stray opener' },
  ]);
});

test('splitLeakedThinking leaves tool calls and other parts untouched and does not mutate input', () => {
  const call = { type: 'toolCall', id: 't1', name: 'roleplay', arguments: {} };
  const input = [{ type: 'text', text: 'a</think>b' }, call];
  const out = splitLeakedThinking(input);
  expect(out?.at(-1)).toBe(call);
  expect(input[0]).toEqual({ type: 'text', text: 'a</think>b' });
});
