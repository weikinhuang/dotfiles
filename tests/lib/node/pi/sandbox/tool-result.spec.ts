/**
 * Specs for the pure front-end of the sandbox `tool_result` pipeline:
 * `resolveSandboxedCommand` (prefer the stashed pre-wrap original, else
 * the rewritten `command`) and `extractBashStderr` (prefer structured
 * `result.stderr`, else the first text content block).
 */

import { describe, expect, test } from 'vitest';

import { stashOriginalCommand } from '../../../../../lib/node/pi/sandbox/markers.ts';
import { extractBashStderr, resolveSandboxedCommand } from '../../../../../lib/node/pi/sandbox/tool-result.ts';

describe('resolveSandboxedCommand', () => {
  test('prefers the stashed pre-wrap original over the rewritten command', () => {
    const input: { command: string } = { command: '__PI_SANDBOX_WRAPPED=1 srt -- ls' };
    stashOriginalCommand(input, 'ls');
    expect(resolveSandboxedCommand(input)).toBe('ls');
  });

  test('falls back to the rewritten command when no stash is present', () => {
    expect(resolveSandboxedCommand({ command: 'echo hi' })).toBe('echo hi');
  });

  test('returns empty string when neither original nor command is a string', () => {
    expect(resolveSandboxedCommand({ command: 42 })).toBe('');
    expect(resolveSandboxedCommand({})).toBe('');
    expect(resolveSandboxedCommand(null)).toBe('');
    expect(resolveSandboxedCommand(undefined)).toBe('');
    expect(resolveSandboxedCommand('nope')).toBe('');
  });
});

describe('extractBashStderr', () => {
  test('prefers structured result.stderr', () => {
    expect(
      extractBashStderr({
        result: { stderr: 'EPERM' },
        content: [{ type: 'text', text: 'ignored' }],
      }),
    ).toBe('EPERM');
  });

  test('falls back to the first text content block', () => {
    expect(
      extractBashStderr({
        content: [{ type: 'image' }, { type: 'text', text: 'from-content' }, { type: 'text', text: 'second' }],
      }),
    ).toBe('from-content');
  });

  test('returns empty string when neither stderr nor a text block is a string', () => {
    expect(extractBashStderr({})).toBe('');
    expect(extractBashStderr({ result: { stderr: 123 } })).toBe('');
    expect(extractBashStderr({ content: [{ type: 'image' }] })).toBe('');
    expect(extractBashStderr({ content: [{ type: 'text' }] })).toBe('');
  });
});
