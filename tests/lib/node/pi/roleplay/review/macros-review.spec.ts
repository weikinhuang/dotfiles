/**
 * Regression: SillyTavern macro forms in lib/node/pi/roleplay/macros.ts
 * (`{{roll:NdM+K}}` modifiers, `{{random::a::b}}` lists).
 */
import { expect, test } from 'vitest';

import { substituteMacros } from '../../../../../../lib/node/pi/roleplay/macros.ts';

test('macros-review: {{roll:1d6+2}} must not silently drop the modifier', () => {
  // rng 0 -> die face 1. Correct: 3 (modifier applied) or left literal (unsupported).
  const out = substituteMacros('{{roll:1d6+2}}', { rng: () => 0 });
  expect(['3', '{{roll:1d6+2}}']).toContain(out);
});

test('macros-review: {{roll:2d6-1}} must not silently drop the modifier', () => {
  const out = substituteMacros('{{roll:2d6-1}}', { rng: () => 0 });
  expect(['1', '{{roll:2d6-1}}']).toContain(out);
});

test('macros-review: ST double-colon {{random::a::b}} picks one option', () => {
  // SillyTavern accepts both `{{random:a,b}}` and `{{random::a::b}}`; imported cards use both.
  const out = substituteMacros('{{random::alpha::beta}}', { rng: () => 0 });
  expect(['alpha', 'beta']).toContain(out);
});

test('macros-review: existing roll / random forms keep working and malformed rolls stay literal', () => {
  const rng = (): number => 0.999;
  expect(substituteMacros('{{roll:2d6}}', { rng })).toBe('12');
  expect(substituteMacros('{{roll:d20}}', { rng })).toBe('20');
  expect(substituteMacros('{{roll:6}}', { rng })).toBe('6');
  expect(substituteMacros('{{roll:6+1}}', { rng })).toBe('7');
  expect(substituteMacros('{{roll:1D6 - 2}}', { rng: () => 0 })).toBe('-1');
  expect(substituteMacros('{{random:a, b}}', { rng })).toBe('b');
  expect(substituteMacros('{{random::x, y::z}}', { rng: () => 0 })).toBe('x, y');
  for (const lit of ['{{roll:1d6abc}}', '{{roll:d}}', '{{roll:1d6+}}', '{{roll:0d6}}', '{{roll:101d6}}']) {
    expect(substituteMacros(lit, { rng })).toBe(lit);
  }
});
