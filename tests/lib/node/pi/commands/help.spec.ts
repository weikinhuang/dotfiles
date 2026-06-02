/**
 * Tests for lib/node/pi/commands/help.ts.
 */

import { describe, expect, test } from 'vitest';

import { isHelpArg } from '../../../../../lib/node/pi/commands/help.ts';

describe('isHelpArg', () => {
  test('recognises the bare help tokens', () => {
    expect(isHelpArg('help')).toBe(true);
    expect(isHelpArg('--help')).toBe(true);
    expect(isHelpArg('-h')).toBe(true);
    expect(isHelpArg('?')).toBe(true);
  });

  test('is case-insensitive and whitespace-tolerant', () => {
    expect(isHelpArg('  HELP ')).toBe(true);
    expect(isHelpArg('--Help')).toBe(true);
    expect(isHelpArg('\t-H\n')).toBe(true);
  });

  test('treats undefined / empty as not a help request', () => {
    expect(isHelpArg(undefined)).toBe(false);
    expect(isHelpArg('')).toBe(false);
    expect(isHelpArg('   ')).toBe(false);
  });

  test('does not match when help is only part of a larger arg list', () => {
    expect(isHelpArg('help me')).toBe(false);
    expect(isHelpArg('--help-please')).toBe(false);
    expect(isHelpArg('list')).toBe(false);
    expect(isHelpArg('preview foo')).toBe(false);
  });
});
