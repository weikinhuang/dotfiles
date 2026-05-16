/**
 * Tests for `lib/node/pi/mode/list.ts`.
 */

import { expect, test } from 'vitest';

import { formatPersonaListing } from '../../../../../lib/node/pi/persona/list.ts';

test('formatPersonaListing: empty nameOrder → empty array (caller signals "no modes loaded")', () => {
  expect(formatPersonaListing({ nameOrder: [], modes: {}, activeName: undefined })).toEqual([]);
});

test('formatPersonaListing: no active mode → "(no mode active)" header + indented entries', () => {
  const lines = formatPersonaListing({
    nameOrder: ['chat', 'plan'],
    modes: {
      chat: { description: 'Long-form Q&A' },
      plan: { description: 'Plan docs' },
    },
    activeName: undefined,
  });

  expect(lines).toEqual(['(no mode active)', '  chat - Long-form Q&A', '  plan - Plan docs']);
});

test('formatPersonaListing: active mode marked with `* ` prefix', () => {
  const lines = formatPersonaListing({
    nameOrder: ['chat', 'plan'],
    modes: {
      chat: { description: 'Long-form Q&A' },
      plan: { description: 'Plan docs' },
    },
    activeName: 'plan',
  });

  expect(lines).toEqual(['(active: plan)', '  chat - Long-form Q&A', '* plan - Plan docs']);
});

test('formatPersonaListing: missing description renders empty after the em-dash', () => {
  const lines = formatPersonaListing({
    nameOrder: ['mystery'],
    modes: { mystery: {} },
    activeName: undefined,
  });

  expect(lines).toEqual(['(no mode active)', '  mystery - ']);
});

test('formatPersonaListing: active mode missing from modes map still renders header', () => {
  // Edge case: active name set but the parsed mode disappeared from the
  // catalog (loadPersonas ran with a different layer). We still emit the
  // header rather than throwing.
  const lines = formatPersonaListing({
    nameOrder: ['chat'],
    modes: { chat: { description: 'Q&A' } },
    activeName: 'ghost',
  });

  expect(lines[0]).toBe('(active: ghost)');
});

test('formatPersonaListing: name order is preserved (caller is responsible for sort)', () => {
  const lines = formatPersonaListing({
    nameOrder: ['z-mode', 'a-mode', 'm-mode'],
    modes: {
      'z-mode': { description: 'z' },
      'a-mode': { description: 'a' },
      'm-mode': { description: 'm' },
    },
    activeName: undefined,
  });

  expect(lines.slice(1)).toEqual(['  z-mode - z', '  a-mode - a', '  m-mode - m']);
});
