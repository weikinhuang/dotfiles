/**
 * Tests for lib/node/pi/bash/hook.ts.
 */

import { describe, expect, test } from 'vitest';

import { extractBashCommand } from '../../../../../lib/node/pi/bash/hook.ts';

describe('extractBashCommand', () => {
  test('returns the verbatim command for a bash event', () => {
    expect(extractBashCommand({ toolName: 'bash', input: { command: 'ls -al' } })).toBe('ls -al');
  });

  test('preserves leading/trailing whitespace (only trims for the empty check)', () => {
    expect(extractBashCommand({ toolName: 'bash', input: { command: '  ls -al  ' } })).toBe('  ls -al  ');
  });

  test('returns undefined for a non-bash tool', () => {
    expect(extractBashCommand({ toolName: 'read', input: { command: 'ls' } })).toBeUndefined();
  });

  test('returns undefined when input is missing', () => {
    expect(extractBashCommand({ toolName: 'bash' })).toBeUndefined();
  });

  test('returns undefined when input.command is missing', () => {
    expect(extractBashCommand({ toolName: 'bash', input: {} })).toBeUndefined();
  });

  test('returns undefined when input.command is non-string', () => {
    expect(extractBashCommand({ toolName: 'bash', input: { command: 42 } })).toBeUndefined();
    expect(extractBashCommand({ toolName: 'bash', input: { command: null } })).toBeUndefined();
  });

  test('returns undefined for empty / whitespace-only commands', () => {
    expect(extractBashCommand({ toolName: 'bash', input: { command: '' } })).toBeUndefined();
    expect(extractBashCommand({ toolName: 'bash', input: { command: '   \t\n' } })).toBeUndefined();
  });
});
