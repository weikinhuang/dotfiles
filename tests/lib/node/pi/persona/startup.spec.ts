/**
 * Tests for lib/node/pi/persona/startup.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { findRestoredPersonaName, selectStartupPersona } from '../../../../../lib/node/pi/persona/startup.ts';

const CUSTOM = 'persona-state';

test('selectStartupPersona precedence: flag > restored > env default', () => {
  expect(selectStartupPersona({ flagName: 'plan', restoredName: 'chat', envDefault: 'kb' })).toBe('plan');
  expect(selectStartupPersona({ restoredName: 'chat', envDefault: 'kb' })).toBe('chat');
  expect(selectStartupPersona({ envDefault: 'kb' })).toBe('kb');
  expect(selectStartupPersona({})).toBeUndefined();
});

test('selectStartupPersona ignores a non-string restored value (explicit clear)', () => {
  expect(selectStartupPersona({ restoredName: null, envDefault: 'kb' })).toBe('kb');
  expect(selectStartupPersona({ restoredName: null })).toBeUndefined();
});

test('findRestoredPersonaName returns the last matching custom entry name', () => {
  const entries = [
    { type: 'custom', customType: CUSTOM, data: { name: 'plan' } },
    { type: 'message', data: { name: 'ignored' } },
    { type: 'custom', customType: CUSTOM, data: { name: 'chat' } },
  ];
  expect(findRestoredPersonaName(entries, CUSTOM)).toBe('chat');
});

test('findRestoredPersonaName returns null for an explicit clear or when absent', () => {
  expect(findRestoredPersonaName([{ type: 'custom', customType: CUSTOM, data: { name: null } }], CUSTOM)).toBeNull();
  expect(findRestoredPersonaName([{ type: 'message' }], CUSTOM)).toBeNull();
  expect(findRestoredPersonaName([], CUSTOM)).toBeNull();
});
