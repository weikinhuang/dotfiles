/**
 * Tests for lib/node/pi/ext/tool-path.ts.
 */

import { expect, test } from 'vitest';

import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';

import { getToolCallPathInput } from '../../../../../lib/node/pi/ext/tool-path.ts';

const event = (toolName: string, input: unknown): ToolCallEvent =>
  ({ type: 'tool_call', toolName, input }) as unknown as ToolCallEvent;

test('getToolCallPathInput: trims the path for read/write/edit events', () => {
  expect(getToolCallPathInput(event('read', { path: '  /tmp/a.txt  ' }))).toBe('/tmp/a.txt');
  expect(getToolCallPathInput(event('write', { path: '/tmp/b.txt' }))).toBe('/tmp/b.txt');
  expect(getToolCallPathInput(event('edit', { path: '/tmp/c.txt' }))).toBe('/tmp/c.txt');
});

test('getToolCallPathInput: returns empty string for other tools', () => {
  expect(getToolCallPathInput(event('bash', { command: 'ls' }))).toBe('');
  expect(getToolCallPathInput(event('grep', { pattern: 'x' }))).toBe('');
});

test('getToolCallPathInput: returns empty string when path is missing', () => {
  expect(getToolCallPathInput(event('read', {}))).toBe('');
  expect(getToolCallPathInput(event('read', { path: undefined }))).toBe('');
});
