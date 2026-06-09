/**
 * Tests for config/pi/avatar/tools/prompt-lib.ts.
 *
 * Pure module - no network or pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  GROUP_GUARDS,
  SFW_GUARD,
  buildPrompt,
  cellPrompt,
  sheetRules,
} from '../../../../../config/pi/avatar/tools/prompt-lib.ts';
import { STYLE, sheetsFor } from '../../../../../config/pi/avatar/tools/sprite-manifest.ts';

const IDENTITY = 'silver hair, red eyes, black tactical coat';

test('cellPrompt: frame 0 includes style, identity, and base pose', () => {
  const prompt = cellPrompt('activities', 'hi', 0, IDENTITY);
  expect(prompt).toContain(`Style: ${STYLE}.`);
  expect(prompt).toContain(`Character: ${IDENTITY}.`);
  expect(prompt).toContain('Expression: hi: waving hello, bright welcoming smile');
  expect(prompt).not.toContain(SFW_GUARD);
});

test('cellPrompt: frame 1 labels the animation beat', () => {
  const prompt = cellPrompt('activities', 'idle', 1, IDENTITY);
  expect(prompt).toContain('Expression: idle [frame 2]: eyes closed in a blink');
});

test('cellPrompt: mature groups append the SFW guard', () => {
  const prompt = cellPrompt('sultry', 'sultry', 0, IDENTITY);
  expect(prompt).toContain(SFW_GUARD);
  expect(GROUP_GUARDS.sultry).toBe(SFW_GUARD);
});

test('cellPrompt: throws for an out-of-range frame', () => {
  expect(() => cellPrompt('activities', 'hi', 99, IDENTITY)).toThrow(
    'Unknown frame 99 for state "hi" in group "activities"',
  );
});

test('sheetRules: mature groups embed the SFW guard', () => {
  expect(sheetRules('desire')).toContain(SFW_GUARD);
  expect(sheetRules('activities')).not.toContain(SFW_GUARD);
});

test('buildPrompt: sheet a lists cells and leaves identity as placeholder', () => {
  const sheet = sheetsFor('activities').find((s) => s.name === 'a');
  expect(sheet).toBeDefined();
  const prompt = buildPrompt('activities', sheet!);
  expect(prompt).toContain('# activities - sheet a');
  expect(prompt).toContain('Character: {identity}.');
  expect(prompt).toContain('  1. hi: waving hello, bright welcoming smile');
  expect(prompt).not.toContain(
    'Keep the identical character, style, palette, framing, and grid layout as the base sheet (a)',
  );
});

test('buildPrompt: non-a sheets include the consistency reminder', () => {
  const sheet = sheetsFor('activities').find((s) => s.name === 'b');
  expect(sheet).toBeDefined();
  const prompt = buildPrompt('activities', sheet!);
  expect(prompt).toContain(
    'Keep the identical character, style, palette, framing, and grid layout as the base sheet (a)',
  );
});
