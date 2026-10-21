/**
 * Tests for lib/node/pi/thinking-precedence.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { parseCliThinkingLevel, resolveThinkingAfterModelSwap } from '../../../../lib/node/pi/thinking-precedence.ts';

test('parseCliThinkingLevel reads --thinking <level>', () => {
  expect(parseCliThinkingLevel(['--model', 'llama-cpp/qwen3-8-27b', '--thinking', 'off', '-p', 'hi'])).toBe('off');
  expect(parseCliThinkingLevel(['--thinking', 'xhigh'])).toBe('xhigh');
});

test('parseCliThinkingLevel ignores missing, invalid, and =-joined values', () => {
  expect(parseCliThinkingLevel(['-p', 'hi'])).toBeUndefined();
  expect(parseCliThinkingLevel(['--thinking'])).toBeUndefined();
  expect(parseCliThinkingLevel(['--thinking', 'turbo'])).toBeUndefined();
  expect(parseCliThinkingLevel(['--thinking=off'])).toBeUndefined();
});

test('parseCliThinkingLevel honours the --model <pattern>:<level> shorthand', () => {
  expect(parseCliThinkingLevel(['--model', 'llama-cpp/qwen3-8-27b:low'])).toBe('low');
  expect(parseCliThinkingLevel(['--model', 'ollama/qwen3:8b'])).toBeUndefined();
});

test('parseCliThinkingLevel: explicit --thinking beats the model shorthand in either order', () => {
  expect(parseCliThinkingLevel(['--model', 'p/m:high', '--thinking', 'off'])).toBe('off');
  expect(parseCliThinkingLevel(['--thinking', 'off', '--model', 'p/m:high'])).toBe('off');
});

test('parseCliThinkingLevel does not treat a prompt string as a flag value', () => {
  expect(parseCliThinkingLevel(['-p', '--thinking'])).toBeUndefined();
});

test('resolveThinkingAfterModelSwap: startup CLI level beats override and prior level', () => {
  expect(
    resolveThinkingAfterModelSwap({
      startup: true,
      cliLevel: 'off',
      overrideLevel: 'high',
      levelBeforeModelSwap: 'low',
    }),
  ).toBe('off');
});

test('resolveThinkingAfterModelSwap: override level beats prior level (startup without CLI flag)', () => {
  expect(resolveThinkingAfterModelSwap({ startup: true, overrideLevel: 'low', levelBeforeModelSwap: 'high' })).toBe(
    'low',
  );
});

test('resolveThinkingAfterModelSwap: interactive switch ignores the CLI flag', () => {
  expect(
    resolveThinkingAfterModelSwap({
      startup: false,
      cliLevel: 'off',
      overrideLevel: 'high',
      levelBeforeModelSwap: 'off',
    }),
  ).toBe('high');
  expect(resolveThinkingAfterModelSwap({ startup: false, cliLevel: 'off', levelBeforeModelSwap: 'low' })).toBe('low');
});

test('resolveThinkingAfterModelSwap: no override level preserves the level from before the model swap', () => {
  expect(resolveThinkingAfterModelSwap({ startup: true, levelBeforeModelSwap: 'off' })).toBe('off');
  expect(resolveThinkingAfterModelSwap({ startup: false })).toBeUndefined();
});
